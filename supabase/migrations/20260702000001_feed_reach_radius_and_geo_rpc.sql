-- Per-post feed reach radius + server-side geo-filtered feed query.

ALTER TABLE public.feed_posts
  ADD COLUMN IF NOT EXISTS reach_radius_km numeric;

COMMENT ON COLUMN public.feed_posts.reach_radius_km IS
  'Max distance (km) from post lat/lng for feed visibility. Default 2 for customer posts; vendor offers use service_radius_km.';

-- Backfill: customer posts default 2 km; vendor posts use vendor service area.
UPDATE public.feed_posts fp
SET reach_radius_km = 2
WHERE fp.reach_radius_km IS NULL
  AND fp.vendor_id IS NULL;

UPDATE public.feed_posts fp
SET reach_radius_km = COALESCE(NULLIF(v.service_radius_km, 0), 2)
FROM public.vendors v
WHERE fp.vendor_id = v.id
  AND fp.reach_radius_km IS NULL;

-- ── submit_customer_feed_post: default 2 km reach + 7-day expiry ─────────────

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
  p_recommended_vendor_phone text DEFAULT NULL
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
    2,
    p_recommended_vendor_id,
    NULLIF(trim(p_recommended_vendor_name), ''),
    NULLIF(trim(p_recommended_vendor_phone), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── vendor_post_offer: reach = vendor service_radius_km ─────────────────────

CREATE OR REPLACE FUNCTION public.vendor_post_offer(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_content text,
  p_starts_at timestamptz DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reach_km numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  SELECT COALESCE(NULLIF(v.service_radius_km, 0), 2)
  INTO v_reach_km
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

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
    v_reach_km
  );
END;
$$;

-- ── get_local_feed_posts: haversine filter per post reach_radius_km ─────────

CREATE OR REPLACE FUNCTION public.get_local_feed_posts(
  p_reader_lat double precision,
  p_reader_lng double precision,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
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
        WHERE fp.is_hidden = false
          AND (fp.expires_at IS NULL OR fp.expires_at > now())
          AND (fp.starts_at IS NULL OR fp.starts_at <= now())
          AND fp.lat IS NOT NULL
          AND fp.lng IS NOT NULL
          AND (
            6371 * 2 * asin(sqrt(
              power(sin(radians(fp.lat - p_reader_lat) / 2), 2)
              + cos(radians(p_reader_lat)) * cos(radians(fp.lat))
                * power(sin(radians(fp.lng - p_reader_lng) / 2), 2)
            ))
          ) <= GREATEST(COALESCE(NULLIF(fp.reach_radius_km, 0), 2), 0.1)
        ORDER BY fp.created_at DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_local_feed_posts(double precision, double precision, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts(double precision, double precision, integer) TO anon, authenticated;
