-- Close UPI claim/confirm/dispute races (FOR UPDATE + status precondition)
-- and add rate limits on claim, confirm, dispute, insert_bill_with_items.

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
  v_rl_key text;
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_identity_key := public._customer_payment_identity_key(p_user_phone, p_device_id);
  v_rl_key := COALESCE(v_identity_key, p_request_id::text);
  -- identifier_type must be device_id|ip|phone|vendor_id (not 'identity')
  IF NOT public.check_and_log_rate_limit(
    'claim_customer_payment',
    CASE WHEN NULLIF(btrim(COALESCE(p_user_phone, '')), '') IS NOT NULL THEN 'phone' ELSE 'device_id' END,
    v_rl_key,
    10,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

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
    r.delivery_payment_timing,
    r.payment_status
  INTO v_req
  FROM public.requests r
  WHERE r.id = p_request_id
    AND r.status IN ('accepted', 'fulfilled')
    AND (
      (p_user_phone IS NOT NULL AND r.user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND r.device_id = p_device_id)
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF v_req.payment_status IS DISTINCT FROM 'unpaid' THEN
    RAISE EXCEPTION 'payment_already_claimed';
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
  WHERE id = p_request_id
    AND payment_status = 'unpaid';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_already_claimed';
  END IF;

  PERFORM public._stamp_request_upi_payee(p_request_id, 'claimed');
END;
$$;

COMMENT ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) IS
  'Customer claims UPI payment under FOR UPDATE + unpaid precondition; rate-limited 10/min per identity. Rejects restricted accounts; anomalous prepaid agent-delivery may require screenshot.';

REVOKE ALL ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirm_upi_payment(
  p_request_id uuid,
  p_vendor_phone text,
  p_device_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_updated integer;
BEGIN
  PERFORM public._assert_vendor_session_matches_request(p_request_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'confirm_upi_payment',
    'phone',
    btrim(COALESCE(p_vendor_phone, '')),
    20,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;

  IF p_device_id IS NOT NULL AND trim(p_device_id) <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.requests r
      WHERE r.id = p_request_id
        AND r.device_id IS NOT NULL
        AND trim(r.device_id) <> ''
        AND trim(r.device_id) = trim(p_device_id)
    ) THEN
      RAISE EXCEPTION 'self_confirmation_blocked';
    END IF;
  END IF;

  SELECT r.payment_status
  INTO v_status
  FROM public.requests r
  WHERE r.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND OR v_status IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  UPDATE public.requests
  SET payment_status = 'confirmed', payment_confirmed_at = now()
  WHERE id = p_request_id
    AND payment_status = 'claimed';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  UPDATE public.order_bills
  SET payment_status = 'paid', paid_at = now()
  WHERE request_id = p_request_id;
END;
$$;

COMMENT ON FUNCTION public.confirm_upi_payment(uuid, text, text) IS
  'Vendor confirms claimed UPI payment under FOR UPDATE; rate-limited 20/min per vendor phone. Optional p_device_id blocks same-device self-confirm.';

REVOKE ALL ON FUNCTION public.confirm_upi_payment(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_upi_payment(uuid, text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dispute_upi_payment(
  p_request_id uuid,
  p_vendor_phone text,
  p_device_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_phone text;
  v_device_id text;
  v_vendor_id uuid;
  v_identity_key text;
  v_distinct_vendors integer;
  v_status text;
  v_updated integer;
BEGIN
  PERFORM public._assert_vendor_session_matches_request(p_request_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'dispute_upi_payment',
    'phone',
    btrim(COALESCE(p_vendor_phone, '')),
    20,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;

  IF p_device_id IS NOT NULL AND trim(p_device_id) <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.requests r
      WHERE r.id = p_request_id
        AND r.device_id IS NOT NULL
        AND trim(r.device_id) <> ''
        AND trim(r.device_id) = trim(p_device_id)
    ) THEN
      RAISE EXCEPTION 'self_confirmation_blocked';
    END IF;
  END IF;

  SELECT r.payment_status
  INTO v_status
  FROM public.requests r
  WHERE r.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND OR v_status IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  UPDATE public.requests
  SET payment_status = 'disputed'
  WHERE id = p_request_id
    AND payment_status = 'claimed'
  RETURNING user_phone, device_id, vendor_id
  INTO v_user_phone, v_device_id, v_vendor_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  INSERT INTO public.payment_dispute_events (
    request_id,
    vendor_id,
    user_phone,
    device_id
  )
  VALUES (
    p_request_id,
    v_vendor_id,
    v_user_phone,
    v_device_id
  );

  v_identity_key := public._customer_payment_identity_key(v_user_phone, v_device_id);
  IF v_identity_key IS NULL THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT e.vendor_id)::integer
  INTO v_distinct_vendors
  FROM public.payment_dispute_events e
  WHERE public._customer_payment_identity_key(e.user_phone, e.device_id) = v_identity_key;

  INSERT INTO public.customer_payment_restrictions (
    identity_key,
    is_restricted,
    restricted_at,
    last_dispute_at
  )
  VALUES (
    v_identity_key,
    v_distinct_vendors >= 2,
    CASE WHEN v_distinct_vendors >= 2 THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (identity_key) DO UPDATE
  SET
    last_dispute_at = now(),
    is_restricted = customer_payment_restrictions.is_restricted
      OR (v_distinct_vendors >= 2),
    restricted_at = CASE
      WHEN v_distinct_vendors >= 2
        AND customer_payment_restrictions.restricted_at IS NULL
        THEN now()
      WHEN v_distinct_vendors >= 2
        AND NOT customer_payment_restrictions.is_restricted
        THEN now()
      ELSE customer_payment_restrictions.restricted_at
    END;
END;
$$;

COMMENT ON FUNCTION public.dispute_upi_payment(uuid, text, text) IS
  'Vendor disputes claimed UPI payment under FOR UPDATE; rate-limited 20/min per vendor phone. Logs dispute event and may restrict after 2 distinct vendors.';

REVOKE ALL ON FUNCTION public.dispute_upi_payment(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_upi_payment(uuid, text, text)
  TO anon, authenticated, service_role;

-- Rate-limit insert_bill_with_items without rewriting the full body.
DO $inject$
DECLARE
  def text;
  injected text;
  rl text :=
    $rl$
  IF p_vendor_id IS NOT NULL AND NOT public.check_and_log_rate_limit(
    'insert_bill_with_items',
    'vendor_id',
    p_vendor_id::text,
    30,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;
$rl$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'insert_bill_with_items'
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'insert_bill_with_items not found';
  END IF;

  IF position('check_and_log_rate_limit' IN def) > 0
     AND position('''insert_bill_with_items''' IN def) > 0 THEN
    RAISE NOTICE 'insert_bill_with_items already rate-limited';
    RETURN;
  END IF;

  injected := regexp_replace(
    def,
    E'(PERFORM public\\._assert_vendor_identity\\(p_vendor_id, p_vendor_phone\\);\\n)',
    E'\\1' || rl || E'\n'
  );

  IF injected IS NULL OR injected = def THEN
    RAISE EXCEPTION 'rate-limit inject failed for insert_bill_with_items';
  END IF;

  EXECUTE injected;
END;
$inject$;
