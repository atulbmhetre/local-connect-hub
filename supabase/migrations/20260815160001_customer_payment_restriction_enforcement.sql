-- Section 5c: server-side claim gate, client lookup RPC, and 90-day auto-lift cron.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ── claim_customer_payment: reject restricted identities ─────────────────────

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
END;
$$;

COMMENT ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) IS
  'Customer claims UPI payment. Rejects restricted accounts; anomalous prepaid agent-delivery orders require payment_screenshot_url.';

REVOKE ALL ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) TO anon, authenticated;

-- ── Client lookup (not bolted onto get_my_orders) ────────────────────────────

CREATE OR REPLACE FUNCTION public.get_customer_payment_restriction_status(
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS TABLE (is_restricted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_identity_key text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_identity_key := public._customer_payment_identity_key(p_user_phone, p_device_id);
  IF v_identity_key IS NULL THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT COALESCE(cpr.is_restricted, false)
  FROM public.customer_payment_restrictions cpr
  WHERE cpr.identity_key = v_identity_key
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_customer_payment_restriction_status(text, text) IS
  'Returns whether the customer identity is cash-only restricted from payment dispute backstop.';

REVOKE ALL ON FUNCTION public.get_customer_payment_restriction_status(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_payment_restriction_status(text, text) TO anon, authenticated, service_role;

-- ── 90-day auto-lift (no admin action) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lift_expired_payment_restrictions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH lifted AS (
    UPDATE public.customer_payment_restrictions cpr
    SET
      is_restricted = false,
      restricted_at = NULL
    WHERE cpr.is_restricted = true
      AND cpr.restricted_at IS NOT NULL
      AND cpr.restricted_at < now() - interval '90 days'
      AND cpr.last_dispute_at < now() - interval '90 days'
    RETURNING cpr.identity_key
  )
  INSERT INTO public.user_notifications (
    user_phone,
    type,
    title,
    body,
    is_informational
  )
  SELECT
    l.identity_key,
    'account_restored',
    'Account Restored',
    'Your account has been restored. Welcome back!',
    true
  FROM lifted l
  WHERE EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.phone = l.identity_key
  );
END;
$$;

COMMENT ON FUNCTION public.lift_expired_payment_restrictions() IS
  'Lifts payment self-declare restrictions after 90 days with no new disputes; notifies phone customers.';

REVOKE ALL ON FUNCTION public.lift_expired_payment_restrictions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lift_expired_payment_restrictions() TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'lift-expired-payment-restrictions';

SELECT cron.schedule(
  'lift-expired-payment-restrictions',
  '0 3 * * *',
  $$SELECT public.lift_expired_payment_restrictions();$$
);
