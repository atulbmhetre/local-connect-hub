-- OTP-off: backfill saved_vendors.user_phone for device-scoped rows (mirrors migrate_device_requests_phone).

CREATE OR REPLACE FUNCTION public.migrate_saved_vendors_phone(
  p_device_id text,
  p_user_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL OR p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.saved_vendors
  SET user_phone = p_user_phone
  WHERE device_id = p_device_id
    AND (user_phone IS NULL OR user_phone <> p_user_phone);
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_saved_vendors_phone(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_saved_vendors_phone(text, text) TO anon, authenticated;
