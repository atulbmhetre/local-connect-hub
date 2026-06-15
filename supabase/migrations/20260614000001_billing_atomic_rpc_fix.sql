-- KB-16: Document billing/khata table DDL (IF NOT EXISTS — no-op on existing DBs).
-- KB-02/03/04/23: Atomic insert_bill_with_items with void cleanup, khata reversal, and khata charge.

-- =============================================================================
-- Part 1 — Table documentation (matches TEST schema as of 2026-06-14)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.order_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.requests(id),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  user_phone text,
  total_amount double precision NOT NULL DEFAULT 0,
  payment_mode text NOT NULL DEFAULT 'cash',
  payment_status text NOT NULL DEFAULT 'unpaid',
  paid_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS order_bills_request_id_key
  ON public.order_bills (request_id);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  description text NOT NULL,
  quantity double precision NOT NULL DEFAULT 1,
  unit text,
  unit_price double precision NOT NULL,
  total_price double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.khata_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  user_phone text NOT NULL,
  total_outstanding double precision NOT NULL DEFAULT 0,
  last_updated timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS khata_ledger_vendor_id_user_phone_key
  ON public.khata_ledger (vendor_id, user_phone);

CREATE TABLE IF NOT EXISTS public.khata_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  user_phone text NOT NULL,
  request_id uuid REFERENCES public.requests(id),
  amount numeric NOT NULL,
  note text,
  payment_mode text NOT NULL DEFAULT 'cash',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Part 2a — order_items FK: CASCADE delete line items when bill row is removed
-- =============================================================================

-- Remove orphan line items before re-pointing FK (safe if none exist).
DELETE FROM public.order_items oi
WHERE NOT EXISTS (
  SELECT 1 FROM public.order_bills ob WHERE ob.request_id = oi.request_id
);

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_request_id_fkey;

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.order_bills(request_id) ON DELETE CASCADE;

-- =============================================================================
-- Part 2b — Atomic insert_bill_with_items (void cleanup + khata in one transaction)
-- =============================================================================

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
