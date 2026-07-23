-- Restore banned-author exclusion on get_local_feed_posts / _count.
--
-- Root cause: 20260722090002 was applied to TEST from an earlier draft that
-- omitted the is_banned filter (CREATE OR REPLACE wiped the clause added by
-- 20260719180001). The migration file was later corrected in git before PROD
-- push, so PROD's schema_migrations.statements for 090002 include is_banned
-- while TEST's recorded statements do not. Version was already marked applied
-- on TEST, so db push never re-ran the corrected file.
--
-- This migration re-applies the canonical bodies (pagination ceiling 200 +
-- banned-author exclusion) so TEST matches PROD / current git. Idempotent on
-- PROD (same function text).

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

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 50), 200), 1);

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
          -- Match vendors_public_discoverable_read: exclude banned author vendors.
          AND (fp.vendor_id IS NULL OR COALESCE(v.is_banned, false) = false)
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

-- ── get_local_feed_posts_count: same filters, no limit, for "Load more" ────

CREATE OR REPLACE FUNCTION public.get_local_feed_posts_count(
  p_reader_lat double precision,
  p_reader_lng double precision,
  p_reader_radius_km integer DEFAULT NULL,
  p_reader_vendor_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_reader_lat IS NULL OR p_reader_lng IS NULL THEN
    RAISE EXCEPTION 'reader_location_required';
  END IF;

  SELECT count(*)
  INTO v_count
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
    -- Match get_local_feed_posts / vendors_public_discoverable_read: exclude banned author vendors.
    AND (fp.vendor_id IS NULL OR COALESCE(v.is_banned, false) = false);

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.get_local_feed_posts_count(double precision, double precision, integer, uuid) IS
  'Total feed posts matching get_local_feed_posts filters (no limit) — used for LocalFeed "Load more" truncatedRemaining.';

REVOKE ALL ON FUNCTION public.get_local_feed_posts_count(double precision, double precision, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts_count(double precision, double precision, integer, uuid)
  TO anon, authenticated, service_role;
