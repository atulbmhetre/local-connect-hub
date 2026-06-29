-- Extend dismiss_order to optionally set appointment_status (declined-booking dismiss).
CREATE OR REPLACE FUNCTION public.dismiss_order(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL,
  p_appointment_status text DEFAULT NULL
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
  SET
    status = 'done',
    appointment_status = COALESCE(p_appointment_status, appointment_status)
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

COMMENT ON FUNCTION public.dismiss_order(uuid, text, text, text) IS
  'Customer dismisses their own order (marks done). SECURITY DEFINER — bypasses RLS while OTP auth is disabled.';

REVOKE ALL ON FUNCTION public.dismiss_order(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_order(uuid, text, text, text) TO anon, authenticated;
