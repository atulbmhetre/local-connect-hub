-- Server-side khata red-limit gate for new charges.
-- Block only when the customer's CURRENT outstanding is already >= khata_red_limit
-- (set/not null and > 0). Crossing into red on this bill is allowed.
-- Lock the ledger row (FOR UPDATE) before the check so concurrent bill-adds
-- cannot both pass on a stale pre-update balance.
-- App stores 0 when khata is disabled; treat NULL or <= 0 as "no limit".

CREATE OR REPLACE FUNCTION public.add_bill_to_khata(
  p_bill_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill record;
  v_red_limit numeric;
  v_outstanding numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;

  SELECT
    ob.id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode,
    ob.payment_status,
    ob.request_id
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found';
  END IF;

  IF v_bill.payment_status <> 'unpaid' THEN
    RAISE EXCEPTION 'bill_not_unpaid';
  END IF;

  IF v_bill.payment_mode = 'khata' THEN
    RAISE EXCEPTION 'bill_already_khata';
  END IF;

  IF v_bill.user_phone IS NULL THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  SELECT v.khata_red_limit
  INTO v_red_limit
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF v_red_limit IS NOT NULL AND v_red_limit > 0 THEN
    INSERT INTO public.khata_ledger (
      vendor_id,
      user_phone,
      total_outstanding,
      last_updated
    )
    VALUES (
      p_vendor_id,
      v_bill.user_phone,
      0,
      now()
    )
    ON CONFLICT (vendor_id, user_phone) DO NOTHING;

    SELECT kl.total_outstanding
    INTO v_outstanding
    FROM public.khata_ledger kl
    WHERE kl.vendor_id = p_vendor_id
      AND kl.user_phone = v_bill.user_phone
    FOR UPDATE;

    IF COALESCE(v_outstanding, 0) >= v_red_limit THEN
      RAISE EXCEPTION 'khata_red_limit_exceeded';
    END IF;
  END IF;

  INSERT INTO public.khata_transactions (
    vendor_id,
    user_phone,
    amount,
    note,
    payment_mode,
    request_id
  )
  VALUES (
    p_vendor_id,
    v_bill.user_phone,
    v_bill.total_amount,
    'Added to khata',
    'khata',
    v_bill.request_id
  );

  INSERT INTO public.khata_ledger (
    vendor_id,
    user_phone,
    total_outstanding,
    last_updated
  )
  VALUES (
    p_vendor_id,
    v_bill.user_phone,
    v_bill.total_amount,
    now()
  )
  ON CONFLICT (vendor_id, user_phone)
  DO UPDATE SET
    total_outstanding = public.khata_ledger.total_outstanding + EXCLUDED.total_outstanding,
    last_updated = now();

  UPDATE public.order_bills
  SET payment_mode = 'khata'
  WHERE id = p_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.add_bill_to_khata(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_bill_to_khata(uuid, uuid, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.insert_bill_with_items(
  p_order_id uuid,
  p_vendor_id uuid,
  p_customer_phone text,
  p_total numeric,
  p_payment_mode text,
  p_payment_status text DEFAULT 'unpaid',
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid;
  v_item jsonb;
  v_name text;
  v_qty numeric;
  v_unit_price numeric;
  v_unit text;
  v_phone text;
  v_void_bill record;
  v_outstanding numeric;
  v_khata_note text;
  v_red_limit numeric;
BEGIN
  v_phone := NULLIF(TRIM(p_customer_phone), '');

  -- KB-02/23: Remove prior void bill (CASCADE deletes order_items via FK).
  -- KB-04: Reverse khata ledger charge before delete when void bill was on khata.
  SELECT
    ob.id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode
  INTO v_void_bill
  FROM public.order_bills ob
  WHERE ob.request_id = p_order_id
    AND ob.payment_status = 'void'
  LIMIT 1;

  IF FOUND THEN
    IF v_void_bill.payment_mode = 'khata' AND v_void_bill.user_phone IS NOT NULL THEN
      INSERT INTO public.khata_transactions (
        vendor_id,
        user_phone,
        amount,
        note,
        payment_mode,
        request_id
      )
      VALUES (
        v_void_bill.vendor_id,
        v_void_bill.user_phone,
        -v_void_bill.total_amount,
        'Bill voided',
        'khata',
        p_order_id
      );

      SELECT kl.total_outstanding
      INTO v_outstanding
      FROM public.khata_ledger kl
      WHERE kl.vendor_id = v_void_bill.vendor_id
        AND kl.user_phone = v_void_bill.user_phone;

      IF FOUND THEN
        UPDATE public.khata_ledger
        SET
          total_outstanding = GREATEST(0, v_outstanding - v_void_bill.total_amount),
          last_updated = now()
        WHERE vendor_id = v_void_bill.vendor_id
          AND user_phone = v_void_bill.user_phone;
      END IF;
    END IF;

    DELETE FROM public.order_bills
    WHERE id = v_void_bill.id;
  END IF;

  INSERT INTO public.order_bills (
    request_id,
    vendor_id,
    user_phone,
    total_amount,
    payment_mode,
    payment_status,
    notes
  )
  VALUES (
    p_order_id,
    p_vendor_id,
    v_phone,
    p_total,
    p_payment_mode,
    p_payment_status,
    NULLIF(TRIM(p_notes), '')
  )
  RETURNING id INTO v_bill_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_name := v_item->>'name';
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price', '')::numeric, 0);
    v_unit := NULLIF(TRIM(COALESCE(v_item->>'unit', '')), '');

    IF v_name IS NOT NULL AND TRIM(v_name) <> '' AND v_unit_price > 0 THEN
      INSERT INTO public.order_items (
        request_id,
        description,
        quantity,
        unit,
        unit_price
      )
      VALUES (
        p_order_id,
        TRIM(v_name),
        GREATEST(v_qty, 1),
        v_unit,
        v_unit_price
      );
    END IF;
  END LOOP;

  -- KB-03: Khata charge in same transaction as bill insert.
  IF p_payment_mode = 'khata' AND v_phone IS NOT NULL THEN
    SELECT v.khata_red_limit
    INTO v_red_limit
    FROM public.vendors v
    WHERE v.id = p_vendor_id;

    IF v_red_limit IS NOT NULL AND v_red_limit > 0 THEN
      INSERT INTO public.khata_ledger (
        vendor_id,
        user_phone,
        total_outstanding,
        last_updated
      )
      VALUES (
        p_vendor_id,
        v_phone,
        0,
        now()
      )
      ON CONFLICT (vendor_id, user_phone) DO NOTHING;

      SELECT kl.total_outstanding
      INTO v_outstanding
      FROM public.khata_ledger kl
      WHERE kl.vendor_id = p_vendor_id
        AND kl.user_phone = v_phone
      FOR UPDATE;

      IF COALESCE(v_outstanding, 0) >= v_red_limit THEN
        RAISE EXCEPTION 'khata_red_limit_exceeded';
      END IF;
    END IF;

    v_khata_note := COALESCE(NULLIF(TRIM(p_notes), ''), 'Bill from order');

    INSERT INTO public.khata_transactions (
      vendor_id,
      user_phone,
      amount,
      note,
      payment_mode,
      request_id
    )
    VALUES (
      p_vendor_id,
      v_phone,
      p_total,
      v_khata_note,
      'khata',
      p_order_id
    );

    INSERT INTO public.khata_ledger (
      vendor_id,
      user_phone,
      total_outstanding,
      last_updated
    )
    VALUES (
      p_vendor_id,
      v_phone,
      p_total,
      now()
    )
    ON CONFLICT (vendor_id, user_phone)
    DO UPDATE SET
      total_outstanding = public.khata_ledger.total_outstanding + EXCLUDED.total_outstanding,
      last_updated = now();
  END IF;

  RETURN v_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_bill_with_items(uuid, uuid, text, numeric, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_bill_with_items(uuid, uuid, text, numeric, text, text, text, jsonb) TO anon, authenticated;
