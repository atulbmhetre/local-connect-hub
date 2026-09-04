-- Fix claim_customer_payment rate-limit identifier_type: 'identity' is not allowed
-- (edge_function_rate_limits_identifier_type_check: device_id|ip|phone|vendor_id).
-- Environments that already applied 20260904150001 need this follow-up.

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
