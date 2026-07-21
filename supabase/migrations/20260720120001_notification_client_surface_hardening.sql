-- Notifications client-surface hardening (inbox mutations + unread count + FCM reassignment):
--   1) Dual phone+device binding on mark/delete/clear (match set_user_device_feed_notifications).
--   2) Rate-limit those mutations at 30/60s (saved-vendor mutation pattern).
--   3) get_user_unread_notification_count — true COUNT(*) for the badge.
--   4) Clear colliding fcm_token on device/phone reassignment in upsert + ensure link.

-- ── helpers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._assert_user_device_binding(
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_devices ud
    WHERE ud.user_phone = trim(p_user_phone)
      AND ud.device_id = trim(p_device_id)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._assert_user_device_binding(text, text) IS
  'Requires non-empty phone+device_id and a matching user_devices row (same gate as feed-toggle).';

REVOKE ALL ON FUNCTION public._assert_user_device_binding(text, text) FROM PUBLIC;

-- ── unread count ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_user_unread_notification_count(
  p_user_phone text,
  p_device_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_count integer;
BEGIN
  PERFORM public._assert_user_device_binding(p_user_phone, p_device_id);

  v_rl_type := 'phone';
  v_rl_id := trim(p_user_phone);
  IF NOT public.check_and_log_rate_limit(
    'get_user_unread_notification_count', v_rl_type, v_rl_id, 120, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_count
  FROM public.user_notifications n
  WHERE n.user_phone = trim(p_user_phone)
    AND n.is_read = false;

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.get_user_unread_notification_count(text, text) IS
  'True unread COUNT(*) for the caller''s inbox (phone+device bound). Used by NotificationBell badge.';

REVOKE ALL ON FUNCTION public.get_user_unread_notification_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_unread_notification_count(text, text)
  TO anon, authenticated, service_role;

-- ── inbox mutations: drop old signatures, recreate with p_device_id ─────────

DROP FUNCTION IF EXISTS public.mark_user_notification_read(text, uuid);
DROP FUNCTION IF EXISTS public.mark_user_notifications_read(text, boolean);
DROP FUNCTION IF EXISTS public.delete_user_notification(text, uuid);
DROP FUNCTION IF EXISTS public.clear_user_notifications(text);

CREATE OR REPLACE FUNCTION public.mark_user_notification_read(
  p_user_phone text,
  p_device_id text,
  p_notification_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_user_device_binding(p_user_phone, p_device_id);

  IF NOT public.check_and_log_rate_limit(
    'mark_user_notification_read', 'phone', trim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.user_notifications
  SET is_read = true, read_at = now()
  WHERE id = p_notification_id
    AND user_phone = trim(p_user_phone);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_user_notifications_read(
  p_user_phone text,
  p_device_id text,
  p_informational_only boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_user_device_binding(p_user_phone, p_device_id);

  IF NOT public.check_and_log_rate_limit(
    'mark_user_notifications_read', 'phone', trim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.user_notifications
  SET is_read = true, read_at = now()
  WHERE user_phone = trim(p_user_phone)
    AND is_read = false
    AND (NOT p_informational_only OR is_informational = true);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_user_notification(
  p_user_phone text,
  p_device_id text,
  p_notification_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_user_device_binding(p_user_phone, p_device_id);

  IF NOT public.check_and_log_rate_limit(
    'delete_user_notification', 'phone', trim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  DELETE FROM public.user_notifications
  WHERE id = p_notification_id
    AND user_phone = trim(p_user_phone);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_user_notifications(
  p_user_phone text,
  p_device_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_user_device_binding(p_user_phone, p_device_id);

  IF NOT public.check_and_log_rate_limit(
    'clear_user_notifications', 'phone', trim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  DELETE FROM public.user_notifications
  WHERE user_phone = trim(p_user_phone);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_user_notification_read(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_user_notification_read(text, text, uuid)
  TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.mark_user_notifications_read(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_user_notifications_read(text, text, boolean)
  TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_user_notification(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_notification(text, text, uuid)
  TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.clear_user_notifications(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_user_notifications(text, text)
  TO anon, authenticated, service_role;

-- ── FCM token collision on same device_id / reused token ────────────────────
-- Dead-token cleanup only clears tokens after FCM delivery failures. It does
-- NOT handle logout→new-phone on the same physical device: upsert keys on
-- (user_phone, device_id), so the previous phone's row can keep the live
-- fcm_token and still receive pushes meant for that hardware.

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
DECLARE
  v_phone text;
  v_device text;
  v_token text;
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

  v_phone := trim(p_user_phone);
  v_device := trim(p_device_id);
  v_token := trim(p_fcm_token);

  -- Other phones on this device must not keep a push token for this hardware.
  UPDATE public.user_devices ud
  SET fcm_token = NULL, updated_at = now()
  WHERE ud.device_id = v_device
    AND ud.user_phone <> v_phone
    AND ud.fcm_token IS NOT NULL;

  -- Same token must not remain on any other row (collision / reassignment).
  UPDATE public.user_devices ud
  SET fcm_token = NULL, updated_at = now()
  WHERE ud.fcm_token = v_token
    AND NOT (ud.user_phone = v_phone AND ud.device_id = v_device);

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
    v_phone,
    v_device,
    v_token,
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
