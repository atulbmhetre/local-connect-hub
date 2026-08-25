-- Phase 1: UPI payee snapshots on requests (intended at bill/sheet, claimed at UTR).
-- Source is vendors.* today; later phases switch _stamp_request_upi_payee to vendor_categories.
-- Cash/khata leave both snapshot sets null.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS intended_upi_id text,
  ADD COLUMN IF NOT EXISTS intended_upi_qr_url text,
  ADD COLUMN IF NOT EXISTS intended_upi_payee_id text,
  ADD COLUMN IF NOT EXISTS claimed_upi_id text,
  ADD COLUMN IF NOT EXISTS claimed_upi_qr_url text,
  ADD COLUMN IF NOT EXISTS claimed_upi_payee_id text;

COMMENT ON COLUMN public.requests.intended_upi_id IS
  'UPI VPA snapshotted at UPI bill create and again when the customer payment sheet is generated.';
COMMENT ON COLUMN public.requests.intended_upi_qr_url IS
  'UPI QR URL snapshotted with intended_upi_id.';
COMMENT ON COLUMN public.requests.intended_upi_payee_id IS
  'Decoded QR payee snapshotted with intended_upi_id.';
COMMENT ON COLUMN public.requests.claimed_upi_id IS
  'UPI VPA snapshotted inside claim_customer_payment when the customer submits a UTR.';
COMMENT ON COLUMN public.requests.claimed_upi_qr_url IS
  'UPI QR URL snapshotted with claimed_upi_id.';
COMMENT ON COLUMN public.requests.claimed_upi_payee_id IS
  'Decoded QR payee snapshotted with claimed_upi_id.';

-- ── Shared stamper (vendors today; swap this body in Phase 2/4) ───────────────

CREATE OR REPLACE FUNCTION public._stamp_request_upi_payee(
  p_request_id uuid,
  p_kind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_mode text;
  v_upi_id text;
  v_upi_qr_url text;
  v_upi_payee_id text;
BEGIN
  IF p_kind NOT IN ('intended', 'claimed') THEN
    RAISE EXCEPTION 'invalid_upi_snapshot_kind';
  END IF;

  SELECT r.vendor_id
  INTO v_vendor_id
  FROM public.requests r
  WHERE r.id = p_request_id;

  IF v_vendor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT ob.payment_mode
  INTO v_mode
  FROM public.order_bills ob
  WHERE ob.request_id = p_request_id
    AND ob.payment_status IS DISTINCT FROM 'void'
  LIMIT 1;

  IF v_mode IS DISTINCT FROM 'upi' THEN
    IF p_kind = 'intended' THEN
      UPDATE public.requests
      SET
        intended_upi_id = NULL,
        intended_upi_qr_url = NULL,
        intended_upi_payee_id = NULL
      WHERE id = p_request_id;
    END IF;
    RETURN;
  END IF;

  -- Phase 1: account-wide vendors UPI. Do not read vendor_categories yet.
  SELECT
    NULLIF(btrim(v.upi_id), ''),
    NULLIF(btrim(v.upi_qr_url), ''),
    NULLIF(btrim(v.upi_qr_payee_id), '')
  INTO v_upi_id, v_upi_qr_url, v_upi_payee_id
  FROM public.vendors v
  WHERE v.id = v_vendor_id;

  IF p_kind = 'intended' THEN
    UPDATE public.requests
    SET
      intended_upi_id = v_upi_id,
      intended_upi_qr_url = v_upi_qr_url,
      intended_upi_payee_id = v_upi_payee_id
    WHERE id = p_request_id;
  ELSE
    UPDATE public.requests
    SET
      claimed_upi_id = v_upi_id,
      claimed_upi_qr_url = v_upi_qr_url,
      claimed_upi_payee_id = v_upi_payee_id
    WHERE id = p_request_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public._stamp_request_upi_payee(uuid, text) IS
  'Internal: snapshot vendors UPI onto requests as intended or claimed. Cash/khata skip claimed and clear intended.';

REVOKE ALL ON FUNCTION public._stamp_request_upi_payee(uuid, text) FROM PUBLIC;

-- ── insert_bill_with_items: stamp intended at bill create ─────────────────────

CREATE OR REPLACE FUNCTION public.insert_bill_with_items(
  p_order_id uuid,
  p_vendor_id uuid,
  p_customer_phone text,
  p_total numeric,
  p_payment_mode text,
  p_payment_status text DEFAULT 'unpaid',
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_delivery_fulfillment_method text DEFAULT NULL,
  p_delivery_payment_timing text DEFAULT NULL
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
  v_fulfillment text;
  v_payment_timing text;
BEGIN
  v_phone := NULLIF(TRIM(p_customer_phone), '');

  IF p_delivery_fulfillment_method IS NOT NULL THEN
    v_fulfillment := NULLIF(btrim(p_delivery_fulfillment_method), '');
    IF v_fulfillment IS NOT NULL AND v_fulfillment NOT IN ('vendor', 'agent') THEN
      RAISE EXCEPTION 'invalid_delivery_fulfillment_method';
    END IF;
    v_payment_timing := NULLIF(btrim(COALESCE(p_delivery_payment_timing, '')), '');
    IF v_fulfillment = 'vendor' THEN
      v_payment_timing := 'postpaid';
    ELSIF v_payment_timing IS NULL THEN
      v_payment_timing := 'postpaid';
    ELSIF v_payment_timing NOT IN ('prepaid', 'postpaid') THEN
      RAISE EXCEPTION 'invalid_delivery_payment_timing';
    END IF;

    UPDATE public.requests r
    SET
      delivery_fulfillment_method = v_fulfillment,
      delivery_payment_timing = v_payment_timing
    WHERE r.id = p_order_id
      AND r.vendor_id = p_vendor_id
      AND r.service_mode = 'delivery'
      AND v_fulfillment IS NOT NULL;
  END IF;

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

  PERFORM public._stamp_request_upi_payee(p_order_id, 'intended');

  RETURN v_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_bill_with_items(
  uuid, uuid, text, numeric, text, text, text, jsonb, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.insert_bill_with_items(
  uuid, uuid, text, numeric, text, text, text, jsonb, text, text
) TO anon, authenticated;

-- ── claim_customer_payment: stamp claimed at UTR submit ───────────────────────

CREATE OR REPLACE FUNCTION public.claim_customer_payment(
  p_request_id uuid,
  p_payment_utr text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL,
  p_payment_screenshot_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_bill record;
  v_requires_screenshot boolean;
  v_screenshot text;
  v_identity_key text;
  v_is_restricted boolean;
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_identity_key := public._customer_payment_identity_key(p_user_phone, p_device_id);
  IF v_identity_key IS NOT NULL THEN
    SELECT cpr.is_restricted
    INTO v_is_restricted
    FROM public.customer_payment_restrictions cpr
    WHERE cpr.identity_key = v_identity_key
    LIMIT 1;

    IF COALESCE(v_is_restricted, false) THEN
      RAISE EXCEPTION 'payment_self_declare_restricted';
    END IF;
  END IF;

  IF p_payment_utr IS NULL OR btrim(p_payment_utr) !~ '^[0-9]{12}$' THEN
    RAISE EXCEPTION 'invalid_utr_format';
  END IF;

  SELECT
    r.id,
    r.vendor_id,
    r.service_mode,
    r.delivery_fulfillment_method,
    r.delivery_payment_timing
  INTO v_req
  FROM public.requests r
  WHERE r.id = p_request_id
    AND r.status IN ('accepted', 'fulfilled')
    AND (
      (p_user_phone IS NOT NULL AND r.user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND r.device_id = p_device_id)
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  SELECT ob.total_amount, ob.payment_mode, ob.payment_status
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.request_id = p_request_id
  LIMIT 1;

  v_requires_screenshot := false;
  IF v_bill.payment_mode = 'upi'
    AND v_bill.payment_status = 'unpaid'
    AND v_req.service_mode = 'delivery'
    AND v_req.delivery_fulfillment_method = 'agent'
    AND v_req.delivery_payment_timing = 'prepaid'
  THEN
    v_requires_screenshot := public._payment_amount_is_anomalous(v_req.vendor_id, v_bill.total_amount);
  END IF;

  v_screenshot := NULLIF(btrim(COALESCE(p_payment_screenshot_url, '')), '');

  IF v_requires_screenshot AND v_screenshot IS NULL THEN
    RAISE EXCEPTION 'payment_screenshot_required';
  END IF;

  IF NOT v_requires_screenshot THEN
    v_screenshot := NULL;
  END IF;

  UPDATE public.requests
  SET
    payment_utr = btrim(p_payment_utr),
    payment_status = 'claimed',
    payment_claimed_at = now(),
    payment_screenshot_url = COALESCE(v_screenshot, payment_screenshot_url)
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  PERFORM public._stamp_request_upi_payee(p_request_id, 'claimed');
END;
$$;

COMMENT ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) IS
  'Customer claims UPI payment. Snapshots claimed UPI payee from vendors. Rejects restricted accounts; anomalous prepaid agent-delivery orders require payment_screenshot_url.';

REVOKE ALL ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) TO anon, authenticated;

-- ── Payment-sheet stamp: capture intended from vendors at display time ────────

CREATE OR REPLACE FUNCTION public.snapshot_intended_upi_payee(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_bill record;
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT
    r.id,
    r.payment_status
  INTO v_req
  FROM public.requests r
  WHERE r.id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND r.user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND r.device_id = p_device_id)
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF COALESCE(v_req.payment_status, 'unpaid') IN ('claimed', 'confirmed', 'disputed') THEN
    RETURN;
  END IF;

  SELECT ob.payment_mode, ob.payment_status
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.request_id = p_request_id
    AND ob.payment_status IS DISTINCT FROM 'void'
  LIMIT 1;

  IF v_bill.payment_mode IS DISTINCT FROM 'upi' THEN
    RETURN;
  END IF;

  PERFORM public._stamp_request_upi_payee(p_request_id, 'intended');
END;
$$;

COMMENT ON FUNCTION public.snapshot_intended_upi_payee(uuid, text, text) IS
  'Customer payment-sheet open: refresh intended UPI snapshot from vendors for unpaid UPI bills.';

REVOKE ALL ON FUNCTION public.snapshot_intended_upi_payee(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.snapshot_intended_upi_payee(uuid, text, text) TO anon, authenticated;
