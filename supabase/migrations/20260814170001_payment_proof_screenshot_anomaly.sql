-- Phase 2: payment screenshot proof for anomalous prepaid agent-delivery UPI claims.
-- No existing vendor average-bill stat — computed fresh from settled order_bills.

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS payment_screenshot_url text;

COMMENT ON COLUMN public.requests.payment_screenshot_url IS
  'Customer-uploaded UPI payment proof screenshot URL (anomalous prepaid agent-delivery claims).';

-- ── Settled bill average (cash/UPI paid only; excludes khata and void) ────────

CREATE OR REPLACE FUNCTION public._vendor_settled_bill_average(p_vendor_id uuid)
RETURNS double precision
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT AVG(ob.total_amount)::double precision
  FROM public.order_bills ob
  WHERE ob.vendor_id = p_vendor_id
    AND ob.payment_status = 'paid'
    AND ob.payment_mode IN ('cash', 'upi');
$$;

REVOKE ALL ON FUNCTION public._vendor_settled_bill_average(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._vendor_settled_bill_count(p_vendor_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::integer
  FROM public.order_bills ob
  WHERE ob.vendor_id = p_vendor_id
    AND ob.payment_status = 'paid'
    AND ob.payment_mode IN ('cash', 'upi');
$$;

REVOKE ALL ON FUNCTION public._vendor_settled_bill_count(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._payment_amount_is_anomalous(
  p_vendor_id uuid,
  p_amount double precision
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_avg double precision;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;

  v_count := public._vendor_settled_bill_count(p_vendor_id);
  IF v_count = 0 THEN
    RETURN true;
  END IF;

  v_avg := public._vendor_settled_bill_average(p_vendor_id);
  IF v_avg IS NULL OR v_avg <= 0 THEN
    RETURN true;
  END IF;

  RETURN p_amount >= (v_avg * 3.0);
END;
$$;

REVOKE ALL ON FUNCTION public._payment_amount_is_anomalous(uuid, double precision) FROM PUBLIC;

-- ── Client preflight: screenshot required for this claim? ────────────────────

CREATE OR REPLACE FUNCTION public.get_payment_claim_requirements(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_bill record;
  v_anomalous boolean;
  v_requires_screenshot boolean;
  v_avg double precision;
  v_count integer;
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
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
  v_anomalous := false;
  v_avg := NULL;
  v_count := 0;

  IF v_bill.payment_mode = 'upi'
    AND v_bill.payment_status = 'unpaid'
    AND v_req.service_mode = 'delivery'
    AND v_req.delivery_fulfillment_method = 'agent'
    AND v_req.delivery_payment_timing = 'prepaid'
  THEN
    v_count := public._vendor_settled_bill_count(v_req.vendor_id);
    v_avg := public._vendor_settled_bill_average(v_req.vendor_id);
    v_anomalous := public._payment_amount_is_anomalous(v_req.vendor_id, v_bill.total_amount);
    v_requires_screenshot := v_anomalous;
  END IF;

  RETURN jsonb_build_object(
    'requires_screenshot', v_requires_screenshot,
    'is_anomalous', v_anomalous,
    'settled_bill_count', v_count,
    'average_amount', v_avg,
    'bill_amount', v_bill.total_amount
  );
END;
$$;

COMMENT ON FUNCTION public.get_payment_claim_requirements(uuid, text, text) IS
  'Customer preflight for prepaid agent-delivery UPI claims: whether screenshot proof is required.';

REVOKE ALL ON FUNCTION public.get_payment_claim_requirements(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payment_claim_requirements(uuid, text, text) TO anon, authenticated;

-- ── claim_customer_payment: optional screenshot URL + server-side gate ───────

DROP FUNCTION IF EXISTS public.claim_customer_payment(uuid, text, text, text);

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
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
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
  'Customer claims UPI payment. Anomalous prepaid agent-delivery orders require payment_screenshot_url.';

REVOKE ALL ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_payment(uuid, text, text, text, text) TO anon, authenticated;

-- ── payment-proofs storage bucket ────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'payment-proofs',
  'payment-proofs',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Customer upload payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Customer update payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Read payment proofs" ON storage.objects;

CREATE POLICY "Customer upload payment proofs"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'payment-proofs');

CREATE POLICY "Customer update payment proofs"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'payment-proofs')
WITH CHECK (bucket_id = 'payment-proofs');

CREATE POLICY "Read payment proofs"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'payment-proofs');
