-- Per-business offer ownership (distinct from target_category_id vendor-audience filter).

ALTER TABLE public.feed_posts
  ADD COLUMN IF NOT EXISTS business_category_id uuid REFERENCES public.categories(id);

COMMENT ON COLUMN public.feed_posts.business_category_id IS
  'Owning vendor business category for offer posts (one active slot per vendor+business). '
  'Not the same as target_category_id, which filters which vendor readers see the post.';

CREATE INDEX IF NOT EXISTS feed_posts_vendor_business_offer_idx
  ON public.feed_posts (vendor_id, business_category_id)
  WHERE type = 'offer' AND is_hidden = false;

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
  p_target_category_id uuid DEFAULT NULL,
  p_business_category_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audience text;
  v_category_id uuid;
  v_lat double precision;
  v_lng double precision;
  v_reach numeric;
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

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

  IF p_business_category_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.category_id = p_business_category_id
        AND vc.status = 'approved'
    ) THEN
      RAISE EXCEPTION 'invalid_business_category';
    END IF;

    SELECT vc.latitude, vc.longitude, vc.service_radius_km
    INTO v_lat, v_lng, v_reach
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_business_category_id;

    IF v_lat IS NULL OR v_lng IS NULL THEN
      RAISE EXCEPTION 'business_location_required';
    END IF;
  ELSE
    v_lat := p_lat;
    v_lng := p_lng;
    v_reach := p_reach_radius_km;
    IF v_lat IS NULL OR v_lng IS NULL THEN
      RAISE EXCEPTION 'location_required';
    END IF;
  END IF;

  UPDATE public.feed_posts
  SET is_hidden = true
  WHERE vendor_id = p_vendor_id
    AND type = 'offer'
    AND is_hidden = false
    AND business_category_id IS NOT DISTINCT FROM p_business_category_id;

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
    target_category_id,
    business_category_id
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
    v_lat,
    v_lng,
    COALESCE(NULLIF(v_reach, 0), 5),
    v_audience,
    v_category_id,
    p_business_category_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid, uuid
) TO anon, authenticated, service_role;

-- Replace paginated feed RPC (drop 5-arg overload first — PostgREST cannot resolve overloads).
DROP FUNCTION IF EXISTS public.get_local_feed_posts(
  double precision,
  double precision,
  integer,
  integer,
  uuid
);

-- Include business_category_id in feed RPC payloads (latest pagination variant).
CREATE OR REPLACE FUNCTION public.get_local_feed_posts(
  p_reader_lat double precision,
  p_reader_lng double precision,
  p_limit integer DEFAULT 50,
  p_reader_radius_km integer DEFAULT NULL,
  p_reader_vendor_id uuid DEFAULT NULL,
  p_cursor_created_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
  v_limit := GREATEST(LEAST(COALESCE(p_limit, 50), 100), 1);

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_data ORDER BY created_at DESC, id DESC)
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
            'business_category_id', fp.business_category_id,
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
          fp.created_at,
          fp.id
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
          AND (
            fp.vendor_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.vendors av
              WHERE av.id = fp.vendor_id
                AND av.is_banned = true
            )
          )
          AND (
            p_cursor_created_at IS NULL
            OR p_cursor_id IS NULL
            OR (fp.created_at, fp.id) < (p_cursor_created_at, p_cursor_id)
          )
        ORDER BY fp.created_at DESC, fp.id DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid, timestamptz, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid, timestamptz, uuid
) TO anon, authenticated, service_role;
