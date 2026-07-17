-- Lightweight phone↔device link (no FCM required) + used by delete-account ownership.

-- Allow association rows without a push token (web / denied notifications).
ALTER TABLE public.user_devices
  ALTER COLUMN fcm_token DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.ensure_user_device_link(
  p_user_phone text,
  p_device_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;

  INSERT INTO public.user_devices (
    user_phone,
    device_id,
    fcm_token,
    updated_at
  )
  VALUES (
    trim(p_user_phone),
    trim(p_device_id),
    NULL,
    now()
  )
  ON CONFLICT (user_phone, device_id) DO UPDATE
  SET
    -- Never clear an existing push token; this RPC only ensures the row exists.
    updated_at = now();
END;
$$;

COMMENT ON FUNCTION public.ensure_user_device_link(text, text) IS
  'Associates device_id with phone in user_devices without requiring FCM/push permission. Safe for web.';

REVOKE ALL ON FUNCTION public.ensure_user_device_link(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_user_device_link(text, text)
  TO anon, authenticated, service_role;
