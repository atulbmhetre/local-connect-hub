DROP POLICY IF EXISTS requests_customer_mark_done ON public.requests;

-- RPC for customer to dismiss (mark done) their own order.
-- Runs SECURITY DEFINER to bypass RLS since OTP auth is not yet live.
-- Validates ownership via device_id OR user_phone passed explicitly from client.
CREATE OR REPLACE FUNCTION public.dismiss_order(
  p_request_id uuid,
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

  UPDATE public.requests
  SET status = 'done'
  WHERE id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR
      (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.dismiss_order IS
  'Customer dismisses their own order (marks done). SECURITY DEFINER — bypasses RLS while OTP auth is disabled.';

REVOKE ALL ON FUNCTION public.dismiss_order FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_order TO anon, authenticated;
