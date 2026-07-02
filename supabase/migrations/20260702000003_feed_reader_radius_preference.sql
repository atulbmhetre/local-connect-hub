-- Reader feed discovery radius preference (Change 1).

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS feed_discovery_radius_km integer DEFAULT 5;

COMMENT ON COLUMN public.app_users.feed_discovery_radius_km IS
  'Reader-side feed discovery cap (km). NULL = city-wide (no reader cap). Default 5.';

-- Align legacy 2 km backfill from 20260702000001 to 5 km default.
UPDATE public.feed_posts
SET reach_radius_km = 5
WHERE reach_radius_km = 2;

CREATE OR REPLACE FUNCTION public.get_feed_preferences(p_user_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_radius integer;
  v_found boolean := false;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT au.feed_discovery_radius_km
  INTO v_radius
  FROM public.app_users au
  WHERE au.phone = v_phone;

  v_found := FOUND;

  RETURN jsonb_build_object(
    'feed_discovery_radius_km',
    CASE WHEN v_found THEN v_radius ELSE 5 END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_feed_discovery_radius(
  p_user_phone text,
  p_radius_km integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_radius_km IS NOT NULL AND p_radius_km <= 0 THEN
    RAISE EXCEPTION 'invalid_radius';
  END IF;

  INSERT INTO public.app_users (phone, feed_discovery_radius_km)
  VALUES (v_phone, p_radius_km)
  ON CONFLICT (phone) DO UPDATE
  SET feed_discovery_radius_km = EXCLUDED.feed_discovery_radius_km;
END;
$$;

REVOKE ALL ON FUNCTION public.get_feed_preferences(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_preferences(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.set_feed_discovery_radius(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_feed_discovery_radius(text, integer) TO anon, authenticated;

-- ── submit_customer_feed_post: poster reach param (Change 2) ─────────────────

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
  p_reach_radius_km numeric DEFAULT 5
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
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF NULLIF(trim(p_content), '') IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  v_type := NULLIF(trim(p_type), '');
  v_expires_at := p_expires_at;
  IF v_type IN ('announcement', 'recommendation') AND v_expires_at IS NULL THEN
    v_expires_at := now() + interval '7 days';
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
    recommended_vendor_phone
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
    COALESCE(NULLIF(p_reach_radius_km, 0), 5),
    p_recommended_vendor_id,
    NULLIF(trim(p_recommended_vendor_name), ''),
    NULLIF(trim(p_recommended_vendor_phone), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_post_offer(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_content text,
  p_starts_at timestamptz DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_reach_radius_km numeric DEFAULT 5
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
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
    reach_radius_km
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
    COALESCE(NULLIF(p_reach_radius_km, 0), 5)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric
) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision, numeric
) TO anon, authenticated;

-- ── get_local_feed_posts: reader cap + recommendation effective reach (Change 4) ─

CREATE OR REPLACE FUNCTION public.get_local_feed_posts(
  p_reader_lat double precision,
  p_reader_lng double precision,
  p_limit integer DEFAULT 50,
  p_reader_radius_km integer DEFAULT NULL
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
        ORDER BY fp.created_at DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer
) TO anon, authenticated;
