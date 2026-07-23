-- Local Feed notify path: honor the same radius logic as the display path
-- (get_local_feed_posts).
--
-- Before: get_feed_post_notify_devices capped every recipient by a single flat
-- radius (app_config.feed_notification_radius_km, passed in by the edge
-- function as p_radius_km). It ignored the post's own reach_radius_km /
-- recommended-vendor service_radius_km AND each device owner's personal
-- feed_discovery_radius_km preference — so notify and display could disagree
-- (e.g. a post with a 2km reach could still notify someone 5km away, or a
-- reader who opted into a smaller discovery radius than the flat default
-- would still get notified for posts outside that radius).
--
-- After: the RPC computes the post's effective_reach_km exactly like
-- get_local_feed_posts (post reach_radius_km, LEAST'd with the tagged
-- recommendation vendor's service_radius_km when applicable), then caps each
-- candidate device by LEAST(effective_reach_km, COALESCE(reader_radius_km,
-- effective_reach_km)) — reader_radius_km being that device owner's
-- app_users.feed_discovery_radius_km (mirrors get_feed_preferences: no row =
-- default 5, row with NULL = city-wide / no extra cap, same semantics as the
-- display path's p_reader_radius_km).
--
-- p_radius_km is kept for signature/back-compat (existing tests pass it) but
-- is now only an optional extra ceiling — it can only shrink, never widen,
-- the post's own computed effective reach.

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

  -- Same effective-reach rule as get_local_feed_posts: a tagged recommendation
  -- is capped by the recommended vendor's own service radius.
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

  -- Optional legacy/back-compat ceiling: can only shrink the post's own reach.
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
  WHERE ud.feed_notifications_enabled IS TRUE
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
      -- Mirror get_feed_preferences: no app_users row => default 5km cap;
      -- row present with feed_discovery_radius_km = NULL => city-wide (no
      -- extra reader cap), same as the display path's p_reader_radius_km.
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
  'Devices eligible for notify-feed-post: same effective-reach + audience rules as get_local_feed_posts, capped per-device by that owner''s feed_discovery_radius_km preference (NULL = city-wide, matches display).';

REVOKE ALL ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text)
  TO service_role;
