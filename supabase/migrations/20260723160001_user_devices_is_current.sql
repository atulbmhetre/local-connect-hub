-- Retain user_devices history when a device switches phones; mark the active
-- link with is_current. Prior phone rows stay for fraud-pattern analysis
-- (same retention spirit as ban/warn/no-show history on account deletion).

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_devices.is_current IS
  'True for the phone currently linked to this device_id; older phone links for the same device stay with is_current=false for audit/fraud analysis.';

-- Backfill: newest updated_at per device_id is current; others false.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY device_id
      ORDER BY updated_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.user_devices
)
UPDATE public.user_devices ud
SET is_current = (ranked.rn = 1)
FROM ranked
WHERE ud.id = ranked.id
  AND ud.is_current IS DISTINCT FROM (ranked.rn = 1);

CREATE UNIQUE INDEX IF NOT EXISTS user_devices_one_current_per_device_idx
  ON public.user_devices (device_id)
  WHERE is_current;

-- ── ensure_user_device_link ───────────────────────────────────────────────────

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

  -- Demote prior phone links for this device; clear their push tokens.
  -- Rows are kept (is_current=false) — do not DELETE.
  UPDATE public.user_devices ud
  SET
    is_current = false,
    fcm_token = CASE WHEN ud.fcm_token IS NOT NULL THEN NULL ELSE ud.fcm_token END,
    updated_at = now()
  WHERE ud.device_id = v_device
    AND ud.user_phone <> v_phone
    AND (ud.is_current OR ud.fcm_token IS NOT NULL);

  INSERT INTO public.user_devices (
    user_phone,
    device_id,
    fcm_token,
    is_current,
    updated_at
  )
  VALUES (
    v_phone,
    v_device,
    NULL,
    true,
    now()
  )
  ON CONFLICT (user_phone, device_id) DO UPDATE
  SET
    is_current = true,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_user_device_link(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_user_device_link(text, text)
  TO anon, authenticated, service_role;

-- ── upsert_user_device ────────────────────────────────────────────────────────

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

  UPDATE public.user_devices ud
  SET
    is_current = false,
    fcm_token = CASE WHEN ud.fcm_token IS NOT NULL THEN NULL ELSE ud.fcm_token END,
    updated_at = now()
  WHERE ud.device_id = v_device
    AND ud.user_phone <> v_phone
    AND (ud.is_current OR ud.fcm_token IS NOT NULL);

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
    is_current,
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
    true,
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
    is_current = true,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_user_device(text, text, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_user_device(text, text, text, double precision, double precision)
  TO anon, authenticated;

-- ── Readers that mean "current phone for this device" ───────────────────────

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
      AND ud.is_current IS TRUE
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

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
    AND ud.device_id = trim(p_device_id)
    AND ud.is_current IS TRUE;

  RETURN v_row;
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
    AND ud.device_id = trim(p_device_id)
    AND ud.is_current IS TRUE;

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
    AND ud.device_id = trim(p_device_id)
    AND ud.is_current IS TRUE;

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
    feed_notifications_enabled = COALESCE(p_enabled, true),
    updated_at = now()
  WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id)
    AND ud.is_current IS TRUE
  RETURNING ud.feed_notifications_enabled INTO v_enabled;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  RETURN v_enabled;
END;
$$;

-- Feed push audience: only current device↔phone links.
CREATE OR REPLACE FUNCTION public.get_feed_post_notify_devices(
  p_post_id uuid,
  p_radius_km numeric DEFAULT NULL,
  p_author_phone text DEFAULT NULL
)
RETURNS TABLE (
  user_phone text,
  fcm_token text,
  last_lat double precision,
  last_lng double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audience text;
  v_category_id uuid;
  v_lat double precision;
  v_lng double precision;
  v_post_type text;
  v_post_reach numeric;
  v_recommended_vendor_id uuid;
  v_vendor_service_radius numeric;
  v_effective_reach numeric;
  v_author text;
BEGIN
  IF p_post_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(NULLIF(trim(fp.target_audience), ''), 'customers'),
    fp.target_category_id,
    fp.lat,
    fp.lng,
    NULLIF(trim(fp.user_phone), ''),
    fp.type,
    fp.reach_radius_km,
    fp.recommended_vendor_id
  INTO v_audience, v_category_id, v_lat, v_lng, v_author, v_post_type, v_post_reach, v_recommended_vendor_id
  FROM public.feed_posts fp
  WHERE fp.id = p_post_id;

  IF NOT FOUND OR v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  IF p_author_phone IS NOT NULL AND NULLIF(trim(p_author_phone), '') IS NOT NULL THEN
    v_author := NULLIF(trim(p_author_phone), '');
  END IF;

  v_effective_reach := COALESCE(NULLIF(v_post_reach, 0), 5);
  IF v_post_type = 'recommendation' AND v_recommended_vendor_id IS NOT NULL THEN
    SELECT NULLIF(v.service_radius_km, 0)
    INTO v_vendor_service_radius
    FROM public.vendors v
    WHERE v.id = v_recommended_vendor_id;

    IF v_vendor_service_radius IS NOT NULL THEN
      v_effective_reach := LEAST(v_effective_reach, v_vendor_service_radius);
    END IF;
  END IF;

  IF p_radius_km IS NOT NULL AND p_radius_km > 0 THEN
    v_effective_reach := LEAST(v_effective_reach, p_radius_km);
  END IF;

  RETURN QUERY
  SELECT
    ud.user_phone,
    ud.fcm_token,
    ud.last_lat,
    ud.last_lng
  FROM public.user_devices ud
  LEFT JOIN LATERAL (
    SELECT v.id AS vendor_id
    FROM public.vendors v
    WHERE v.phone = ud.user_phone
    ORDER BY v.created_at DESC NULLS LAST
    LIMIT 1
  ) reader ON true
  LEFT JOIN public.app_users au ON au.phone = ud.user_phone
  WHERE ud.is_current IS TRUE
    AND ud.feed_notifications_enabled IS TRUE
    AND ud.last_location_at > now() - interval '30 days'
    AND ud.fcm_token IS NOT NULL
    AND NULLIF(trim(ud.fcm_token), '') IS NOT NULL
    AND ud.last_lat IS NOT NULL
    AND ud.last_lng IS NOT NULL
    AND (v_author IS NULL OR ud.user_phone IS DISTINCT FROM v_author)
    AND (
      6371 * 2 * asin(sqrt(
        power(sin(radians(ud.last_lat - v_lat) / 2), 2)
        + cos(radians(v_lat)) * cos(radians(ud.last_lat))
          * power(sin(radians(ud.last_lng - v_lng) / 2), 2)
      ))
    ) <= LEAST(
      v_effective_reach,
      COALESCE(
        CASE WHEN au.phone IS NULL THEN 5 ELSE au.feed_discovery_radius_km END,
        v_effective_reach
      )
    )
    AND public.feed_post_matches_reader_audience(
      v_audience,
      v_category_id,
      reader.vendor_id
    );
END;
$$;

COMMENT ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text) IS
  'Devices eligible for notify-feed-post: current links only (is_current), same reach/audience rules as get_local_feed_posts.';
