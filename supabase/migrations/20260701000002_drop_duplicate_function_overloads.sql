-- Fix 1: remove duplicate PostgREST overloads (Session 57 CREATE OR REPLACE left old signatures).
DROP FUNCTION IF EXISTS public.register_vendor(
  p_name text, p_shop_name text, p_category text, p_phone text,
  p_upi_id text, p_service_mode text, p_vendor_type text,
  p_vendor_note text, p_latitude double precision,
  p_longitude double precision, p_referral_code text,
  p_category_ids uuid[], p_category_service_modes text[]
);

DROP FUNCTION IF EXISTS public.dismiss_order(
  p_request_id uuid, p_device_id text, p_user_phone text
);

-- Type-only signatures (required for reliable DROP when overloads coexist).
DROP FUNCTION IF EXISTS public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, uuid[], text[]
);
DROP FUNCTION IF EXISTS public.dismiss_order(uuid, text, text);

-- Fix 2: user_devices writes via SECURITY DEFINER RPCs (anon cannot satisfy auth_user_phone() RLS).

CREATE OR REPLACE FUNCTION public.upsert_user_device(
  p_user_phone text,
  p_device_id text,
  p_fcm_token text,
  p_last_lat double precision DEFAULT NULL,
  p_last_lng double precision DEFAULT NULL
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
  IF p_fcm_token IS NULL OR trim(p_fcm_token) = '' THEN
    RAISE EXCEPTION 'fcm_token_required';
  END IF;

  INSERT INTO public.user_devices (
    user_phone,
    device_id,
    fcm_token,
    last_lat,
    last_lng,
    last_location_at,
    updated_at
  )
  VALUES (
    trim(p_user_phone),
    trim(p_device_id),
    trim(p_fcm_token),
    p_last_lat,
    p_last_lng,
    CASE
      WHEN p_last_lat IS NOT NULL AND p_last_lng IS NOT NULL THEN now()
      ELSE NULL
    END,
    now()
  )
  ON CONFLICT (user_phone, device_id) DO UPDATE
  SET
    fcm_token = EXCLUDED.fcm_token,
    last_lat = COALESCE(EXCLUDED.last_lat, public.user_devices.last_lat),
    last_lng = COALESCE(EXCLUDED.last_lng, public.user_devices.last_lng),
    last_location_at = CASE
      WHEN EXCLUDED.last_lat IS NOT NULL AND EXCLUDED.last_lng IS NOT NULL THEN now()
      ELSE public.user_devices.last_location_at
    END,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.update_user_device_location(
  p_user_phone text,
  p_device_id text,
  p_last_lat double precision,
  p_last_lng double precision
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

  UPDATE public.user_devices ud
  SET
    last_lat = p_last_lat,
    last_lng = p_last_lng,
    last_location_at = now(),
    updated_at = now()
  WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_device_feed_notifications(
  p_user_phone text,
  p_device_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;

  SELECT ud.feed_notifications_enabled
  INTO v_enabled
  FROM public.user_devices ud
  WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id);

  RETURN COALESCE(v_enabled, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_user_device_feed_notifications(
  p_user_phone text,
  p_device_id text,
  p_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;

  UPDATE public.user_devices ud
  SET
    feed_notifications_enabled = p_enabled,
    updated_at = now()
  WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id)
  RETURNING ud.feed_notifications_enabled INTO v_enabled;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  RETURN v_enabled;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_user_devices_for_phone(
  p_user_phone text
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

  DELETE FROM public.user_devices ud
  WHERE ud.user_phone = trim(p_user_phone);
END;
$$;

-- user_devices: SELECT-only for anon/authenticated; writes via RPCs above.
DROP POLICY IF EXISTS user_devices_owner ON public.user_devices;

CREATE POLICY user_devices_select ON public.user_devices
  FOR SELECT
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone());

-- Grants
REVOKE ALL ON FUNCTION public.upsert_user_device(text, text, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_user_device(text, text, text, double precision, double precision) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.update_user_device_location(text, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_user_device_location(text, text, double precision, double precision) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_user_device_feed_notifications(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_device_feed_notifications(text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.set_user_device_feed_notifications(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_device_feed_notifications(text, text, boolean) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.delete_user_devices_for_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_devices_for_phone(text) TO anon, authenticated;
