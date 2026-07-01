-- Read user_devices via SECURITY DEFINER RPC (anon SELECT blocked by auth_user_phone() RLS).

CREATE OR REPLACE FUNCTION public.get_user_device(
  p_user_phone text,
  p_device_id text
)
RETURNS public.user_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.user_devices;
BEGIN
  IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;

  SELECT ud.*
  INTO v_row
  FROM public.user_devices ud
  WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id);

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_device(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_device(text, text) TO anon, authenticated;
