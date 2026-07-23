-- Rate-limit device-link / request-migrate RPCs used by FirstOpen + PhoneEntry.
-- Shape matches migrate_saved_vendors_phone: 30 calls / 60s per device_id.

CREATE OR REPLACE FUNCTION public.migrate_device_requests_phone(
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

  IF NOT public.check_and_log_rate_limit(
    'migrate_device_requests_phone',
    'device_id',
    btrim(p_device_id),
    30,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.requests
  SET user_phone = p_user_phone
  WHERE device_id = p_device_id
    AND (user_phone IS NULL OR user_phone <> p_user_phone);
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_device_requests_phone(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_device_requests_phone(text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.ensure_user_device_link(
  p_user_phone text,
  p_device_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_device text;
BEGIN
  IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;

  v_phone := trim(p_user_phone);
  v_device := trim(p_device_id);

  IF NOT public.check_and_log_rate_limit(
    'ensure_user_device_link',
    'device_id',
    v_device,
    30,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Phone switch on the same device: stop delivering pushes to the prior phone.
  UPDATE public.user_devices ud
  SET fcm_token = NULL, updated_at = now()
  WHERE ud.device_id = v_device
    AND ud.user_phone <> v_phone
    AND ud.fcm_token IS NOT NULL;

  INSERT INTO public.user_devices (
    user_phone,
    device_id,
    fcm_token,
    updated_at
  )
  VALUES (
    v_phone,
    v_device,
    NULL,
    now()
  )
  ON CONFLICT (user_phone, device_id) DO UPDATE
  SET
    -- Never clear an existing push token on the caller's own row; this RPC
    -- only ensures the row exists. Cross-phone tokens cleared above.
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_user_device_link(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_user_device_link(text, text) TO anon, authenticated, service_role;
