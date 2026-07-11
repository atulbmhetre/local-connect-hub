-- Require 12-digit UTR on customer payment claims (matches PaymentSheet client validation).

CREATE OR REPLACE FUNCTION public.claim_customer_payment(
  p_request_id uuid,
  p_payment_utr text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_payment_utr IS NULL OR btrim(p_payment_utr) !~ '^[0-9]{12}$' THEN
    RAISE EXCEPTION 'invalid_utr_format';
  END IF;

  UPDATE public.requests
  SET
    payment_utr = btrim(p_payment_utr),
    payment_status = 'claimed',
    payment_claimed_at = now()
  WHERE id = p_request_id
    AND status = 'fulfilled'
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.claim_customer_payment(uuid, text, text, text) IS
  'Customer claims UPI payment on a fulfilled order. UTR must be exactly 12 digits.';

REVOKE ALL ON FUNCTION public.claim_customer_payment(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_payment(uuid, text, text, text) TO anon, authenticated;
