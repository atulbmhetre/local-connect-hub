-- Feed post audience targeting: customers / vendors / both, optional category scope.
-- Reader category membership is resolved server-side from vendor_categories when
-- get_local_feed_posts receives p_reader_vendor_id (never trust client category claims).

ALTER TABLE public.feed_posts
  ADD COLUMN IF NOT EXISTS target_audience text NOT NULL DEFAULT 'customers',
  ADD COLUMN IF NOT EXISTS target_category_id uuid REFERENCES public.categories(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'feed_posts_target_audience_check'
      AND conrelid = 'public.feed_posts'::regclass
  ) THEN
    ALTER TABLE public.feed_posts
      ADD CONSTRAINT feed_posts_target_audience_check
      CHECK (target_audience IN ('customers', 'vendors', 'both'));
  END IF;
END $$;

COMMENT ON COLUMN public.feed_posts.target_audience IS
  'Who should see this post: customers, vendors, or both.';
COMMENT ON COLUMN public.feed_posts.target_category_id IS
  'Optional category scope for vendor-targeted posts. NULL = all categories.';

CREATE INDEX IF NOT EXISTS feed_posts_target_audience_idx
  ON public.feed_posts (target_audience);
CREATE INDEX IF NOT EXISTS feed_posts_target_category_id_idx
  ON public.feed_posts (target_category_id);

-- ── submit_customer_feed_post (defaults kept; customer UI does not expose targeting) ─

DROP FUNCTION IF EXISTS public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric
);

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
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF NULLIF(trim(p_content), '') IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  -- Customer posts always target customers; ignore client attempts to set vendor targeting.
  v_audience := 'customers';
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
    COALESCE(NULLIF(p_reach_radius_km, 0), 5),
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

-- ── vendor_post_offer ────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision, numeric
);

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

-- ── get_local_feed_posts (+ reader vendor id for category membership) ────────

DROP FUNCTION IF EXISTS public.get_local_feed_posts(
  double precision, double precision, integer, integer
);

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
  v_is_vendor boolean;
BEGIN
  -- FUTURE: Replace haversine distance check with pincode adjacency lookup
  -- Interface: p_reader_lat/lng stays the same, only internal filter changes
  -- Requires: pincode_adjacency table (data source: TBD)
  -- This comment intentional — do not remove

  IF p_reader_lat IS NULL OR p_reader_lng IS NULL THEN
    RAISE EXCEPTION 'reader_location_required';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 50), 100), 1);
  v_is_vendor := p_reader_vendor_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = p_reader_vendor_id);

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
          AND (
            CASE
              WHEN v_is_vendor THEN
                -- Vendors: audience must include vendors; category null = all vendor categories.
                fp.target_audience IN ('vendors', 'both')
                AND (
                  fp.target_category_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM public.vendor_categories vc
                    WHERE vc.vendor_id = p_reader_vendor_id
                      AND vc.category_id = fp.target_category_id
                      AND vc.status = 'approved'
                  )
                )
              ELSE
                -- Customers have no vendor_categories membership. Category scope applies only to
                -- vendor readers, so customers see any post whose audience includes customers
                -- (Customers / Both) regardless of target_category_id. That way Both+Grocery
                -- reaches all customers + grocery vendors.
                fp.target_audience IN ('customers', 'both')
            END
          )
        ORDER BY fp.created_at DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_customer_feed_post(
  text, text, text, timestamptz, text, double precision, double precision,
  uuid, text, text, numeric, text, uuid
) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid
) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid
) TO anon, authenticated;
