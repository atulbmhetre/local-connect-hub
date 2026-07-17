-- Local Feed: share get_local_feed_posts audience rules with notify-feed-post,
-- and rate-limit feed post creation (5 / 10 minutes per phone or vendor).

-- ============================================================================
-- A. Shared audience matcher (exact rules from get_local_feed_posts)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.feed_post_matches_reader_audience(
  p_target_audience text,
  p_target_category_id uuid,
  p_reader_vendor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_vendor boolean;
  v_audience text;
BEGIN
  v_audience := COALESCE(NULLIF(trim(p_target_audience), ''), 'customers');
  v_is_vendor := p_reader_vendor_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = p_reader_vendor_id);

  IF v_is_vendor THEN
    -- Vendors: audience must include vendors; category null = all vendor categories.
    RETURN v_audience IN ('vendors', 'both')
      AND (
        p_target_category_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.vendor_categories vc
          WHERE vc.vendor_id = p_reader_vendor_id
            AND vc.category_id = p_target_category_id
            AND vc.status = 'approved'
        )
      );
  END IF;

  -- Customers have no vendor_categories membership. Category scope applies only to
  -- vendor readers, so customers see any post whose audience includes customers
  -- (Customers / Both) regardless of target_category_id.
  RETURN v_audience IN ('customers', 'both');
END;
$$;

COMMENT ON FUNCTION public.feed_post_matches_reader_audience(text, uuid, uuid) IS
  'Same audience/category visibility rules as get_local_feed_posts (customer vs vendor reader).';

REVOKE ALL ON FUNCTION public.feed_post_matches_reader_audience(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feed_post_matches_reader_audience(text, uuid, uuid)
  TO anon, authenticated, service_role;

-- ============================================================================
-- B. get_local_feed_posts — call the shared helper (no logic drift)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_local_feed_posts(
  p_reader_lat double precision,
  p_reader_lng double precision,
  p_limit integer DEFAULT 50,
  p_reader_radius_km integer DEFAULT NULL,
  p_reader_vendor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
  -- FUTURE: Replace haversine distance check with pincode adjacency lookup
  -- Interface: p_reader_lat/lng stays the same, only internal filter changes
  -- Requires: pincode_adjacency table (data source: TBD)
  -- This comment intentional — do not remove

  IF p_reader_lat IS NULL OR p_reader_lng IS NULL THEN
    RAISE EXCEPTION 'reader_location_required';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 50), 100), 1);

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_data ORDER BY created_at DESC)
      FROM (
        SELECT
          jsonb_build_object(
            'id', fp.id,
            'user_phone', fp.user_phone,
            'vendor_id', fp.vendor_id,
            'type', fp.type,
            'content', fp.content,
            'expires_at', fp.expires_at,
            'image_url', fp.image_url,
            'lat', fp.lat,
            'lng', fp.lng,
            'reach_radius_km', fp.reach_radius_km,
            'flagged_count', fp.flagged_count,
            'is_hidden', fp.is_hidden,
            'created_at', fp.created_at,
            'recommended_vendor_id', fp.recommended_vendor_id,
            'recommended_vendor_name', fp.recommended_vendor_name,
            'recommended_vendor_phone', fp.recommended_vendor_phone,
            'target_audience', fp.target_audience,
            'target_category_id', fp.target_category_id,
            'vendors', CASE
              WHEN v.id IS NOT NULL THEN jsonb_build_object(
                'shop_name', v.shop_name,
                'category', v.category
              )
              ELSE NULL
            END,
            'recommended_vendor', CASE
              WHEN rv.id IS NOT NULL THEN jsonb_build_object(
                'shop_name', rv.shop_name,
                'service_mode', rv.service_mode
              )
              ELSE NULL
            END
          ) AS row_data,
          fp.created_at
        FROM public.feed_posts fp
        LEFT JOIN public.vendors v ON v.id = fp.vendor_id
        LEFT JOIN public.vendors rv ON rv.id = fp.recommended_vendor_id
        CROSS JOIN LATERAL (
          SELECT
            (
              6371 * 2 * asin(sqrt(
                power(sin(radians(fp.lat - p_reader_lat) / 2), 2)
                + cos(radians(p_reader_lat)) * cos(radians(fp.lat))
                  * power(sin(radians(fp.lng - p_reader_lng) / 2), 2)
              ))
            ) AS distance_km,
            CASE
              WHEN fp.type = 'recommendation'
                AND fp.recommended_vendor_id IS NOT NULL
              THEN LEAST(
                COALESCE(NULLIF(fp.reach_radius_km, 0), 5),
                COALESCE(NULLIF(rv.service_radius_km, 0), 5)
              )
              ELSE COALESCE(NULLIF(fp.reach_radius_km, 0), 5)
            END AS effective_reach_km
        ) geo
        WHERE fp.is_hidden = false
          AND (fp.expires_at IS NULL OR fp.expires_at > now())
          AND (fp.starts_at IS NULL OR fp.starts_at <= now())
          AND fp.lat IS NOT NULL
          AND fp.lng IS NOT NULL
          AND geo.distance_km <= LEAST(
            geo.effective_reach_km,
            COALESCE(p_reader_radius_km, geo.effective_reach_km)
          )
          AND public.feed_post_matches_reader_audience(
            fp.target_audience,
            fp.target_category_id,
            p_reader_vendor_id
          )
        ORDER BY fp.created_at DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid
) TO anon, authenticated, service_role;

-- ============================================================================
-- C. Notify recipients: devices in radius that pass the same audience helper
-- ============================================================================

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
  v_radius numeric;
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
    NULLIF(trim(fp.user_phone), '')
  INTO v_audience, v_category_id, v_lat, v_lng, v_author
  FROM public.feed_posts fp
  WHERE fp.id = p_post_id;

  IF NOT FOUND OR v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  IF p_author_phone IS NOT NULL AND NULLIF(trim(p_author_phone), '') IS NOT NULL THEN
    v_author := NULLIF(trim(p_author_phone), '');
  END IF;

  v_radius := COALESCE(NULLIF(p_radius_km, 0), (
    SELECT NULLIF(trim(ac.value), '')::numeric
    FROM public.app_config ac
    WHERE ac.key = 'feed_notification_radius_km'
    LIMIT 1
  ), 5);

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
    ) <= v_radius
    AND public.feed_post_matches_reader_audience(
      v_audience,
      v_category_id,
      reader.vendor_id
    );
END;
$$;

COMMENT ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text) IS
  'Devices eligible for notify-feed-post: radius + feed_post_matches_reader_audience (same as feed display).';

REVOKE ALL ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text)
  TO service_role;

-- ============================================================================
-- D. Rate-limit submit_customer_feed_post (5 / 10 min per phone)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_customer_feed_post(
  p_user_phone text,
  p_type text,
  p_content text,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_recommended_vendor_id uuid DEFAULT NULL,
  p_recommended_vendor_name text DEFAULT NULL,
  p_recommended_vendor_phone text DEFAULT NULL,
  p_reach_radius_km numeric DEFAULT 5,
  p_target_audience text DEFAULT 'customers',
  p_target_category_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_type text;
  v_id uuid;
  v_expires_at timestamptz;
  v_audience text;
  v_reach numeric;
  c_max_customer_reach numeric := 25;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF NULLIF(trim(p_content), '') IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'submit_customer_feed_post',
    'phone',
    v_phone,
    5,
    600
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Customer posts always target customers; ignore client attempts to set vendor targeting.
  v_audience := 'customers';
  v_type := NULLIF(trim(p_type), '');
  v_expires_at := p_expires_at;
  IF v_type IN ('announcement', 'recommendation') AND v_expires_at IS NULL THEN
    v_expires_at := now() + interval '7 days';
  END IF;

  -- Modest reach only: city-wide / nationwide (9999+) or anything above 25 → 25.
  v_reach := COALESCE(NULLIF(p_reach_radius_km, 0), 5);
  IF v_reach >= 9999 OR v_reach > c_max_customer_reach THEN
    v_reach := c_max_customer_reach;
  END IF;

  INSERT INTO public.feed_posts (
    user_phone,
    vendor_id,
    type,
    content,
    expires_at,
    image_url,
    lat,
    lng,
    reach_radius_km,
    recommended_vendor_id,
    recommended_vendor_name,
    recommended_vendor_phone,
    target_audience,
    target_category_id
  )
  VALUES (
    v_phone,
    NULL,
    v_type,
    trim(p_content),
    v_expires_at,
    NULLIF(trim(p_image_url), ''),
    p_lat,
    p_lng,
    v_reach,
    p_recommended_vendor_id,
    NULLIF(trim(p_recommended_vendor_name), ''),
    NULLIF(trim(p_recommended_vendor_phone), ''),
    v_audience,
    NULL
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric, text, uuid
) TO anon, authenticated, service_role;

-- ============================================================================
-- E. Rate-limit vendor_post_offer (5 / 10 min per vendor_id)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.vendor_post_offer(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_content text,
  p_starts_at timestamptz DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_reach_radius_km numeric DEFAULT 5,
  p_target_audience text DEFAULT 'customers',
  p_target_category_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audience text;
  v_category_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'vendor_post_offer',
    'vendor_id',
    p_vendor_id::text,
    5,
    600
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  v_audience := COALESCE(NULLIF(trim(p_target_audience), ''), 'customers');
  IF v_audience NOT IN ('customers', 'vendors', 'both') THEN
    RAISE EXCEPTION 'invalid_target_audience';
  END IF;

  -- Category targeting only applies when vendors (or both) are in the audience.
  IF v_audience = 'customers' THEN
    v_category_id := NULL;
  ELSE
    v_category_id := p_target_category_id;
    IF v_category_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.categories c WHERE c.id = v_category_id
    ) THEN
      RAISE EXCEPTION 'invalid_target_category';
    END IF;
  END IF;

  INSERT INTO public.feed_posts (
    type,
    vendor_id,
    user_phone,
    content,
    is_hidden,
    starts_at,
    expires_at,
    image_url,
    lat,
    lng,
    reach_radius_km,
    target_audience,
    target_category_id
  )
  VALUES (
    'offer',
    p_vendor_id,
    p_vendor_phone,
    p_content,
    false,
    p_starts_at,
    p_expires_at,
    p_image_url,
    p_lat,
    p_lng,
    COALESCE(NULLIF(p_reach_radius_km, 0), 5),
    v_audience,
    v_category_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid
) TO anon, authenticated, service_role;
