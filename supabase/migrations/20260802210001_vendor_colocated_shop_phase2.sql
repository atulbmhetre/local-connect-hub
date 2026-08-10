-- Phase 2: per-business location WRITE path (TEST first).
-- Same-shop tolerance = 75m (GPS_MATCH_TOLERANCE_M floor).
-- Does NOT change tier computation / TrustBadge (Phase 3).

-- ── Haversine meters (inline; matches src/lib/gpsMatch.ts) ─────────────────

CREATE OR REPLACE FUNCTION public._haversine_meters(
  p_lat1 double precision,
  p_lng1 double precision,
  p_lat2 double precision,
  p_lng2 double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_lat1 IS NULL OR p_lng1 IS NULL OR p_lat2 IS NULL OR p_lng2 IS NULL THEN NULL
    ELSE 6371000.0 * 2.0 * asin(sqrt(
      power(sin(radians(p_lat2 - p_lat1) / 2.0), 2)
      + cos(radians(p_lat1)) * cos(radians(p_lat2))
        * power(sin(radians(p_lng2 - p_lng1) / 2.0), 2)
    ))
  END;
$$;

COMMENT ON FUNCTION public._haversine_meters(double precision, double precision, double precision, double precision) IS
  'Distance in meters between two WGS84 points (haversine).';

REVOKE ALL ON FUNCTION public._haversine_meters(
  double precision, double precision, double precision, double precision
) FROM PUBLIC;

-- ── Find nearest co-located business within 75m ─────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_find_colocated_category(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_lat double precision,
  p_lng double precision,
  p_exclude_category_id uuid DEFAULT NULL
)
RETURNS TABLE (
  category_id uuid,
  distance_meters double precision,
  shop_photo_url text,
  latitude double precision,
  longitude double precision,
  category_label text,
  brand_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION 'gps_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = p_vendor_id AND v.phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    vc.category_id,
    public._haversine_meters(p_lat, p_lng, vc.latitude, vc.longitude) AS distance_meters,
    vc.shop_photo_url,
    vc.latitude,
    vc.longitude,
    c.label AS category_label,
    vc.brand_name
  FROM public.vendor_categories vc
  LEFT JOIN public.categories c ON c.id = vc.category_id
  WHERE vc.vendor_id = p_vendor_id
    AND vc.latitude IS NOT NULL
    AND vc.longitude IS NOT NULL
    AND vc.shop_photo_url IS NOT NULL
    AND trim(vc.shop_photo_url) <> ''
    AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    AND (p_exclude_category_id IS NULL OR vc.category_id IS DISTINCT FROM p_exclude_category_id)
    AND public._haversine_meters(p_lat, p_lng, vc.latitude, vc.longitude) <= 75.0
  ORDER BY distance_meters ASC NULLS LAST
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.vendor_find_colocated_category(
  uuid, text, double precision, double precision, uuid
) IS
  'Nearest other business within 75m with a reusable shop photo (excludes soft-fail).';

REVOKE ALL ON FUNCTION public.vendor_find_colocated_category(
  uuid, text, double precision, double precision, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_find_colocated_category(
  uuid, text, double precision, double precision, uuid
) TO anon, authenticated, service_role;

-- ── Inherit photo/location from a co-located business (not admin green) ─────

CREATE OR REPLACE FUNCTION public.vendor_inherit_colocated_shop_photo(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_from_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from record;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_category_id IS NULL OR p_from_category_id IS NULL THEN
    RAISE EXCEPTION 'category_required';
  END IF;
  IF p_category_id = p_from_category_id THEN
    RAISE EXCEPTION 'invalid_inherit_source';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = p_vendor_id AND v.phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendor_categories
    WHERE vendor_id = p_vendor_id AND category_id = p_category_id
  ) THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  SELECT
    vc.latitude,
    vc.longitude,
    vc.shop_photo_url,
    vc.gps_match_distance,
    vc.location_accuracy,
    vc.photo_accuracy,
    vc.verification_status
  INTO v_from
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_from_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_category_not_found';
  END IF;
  IF v_from.latitude IS NULL OR v_from.longitude IS NULL THEN
    RAISE EXCEPTION 'source_location_missing';
  END IF;
  IF v_from.shop_photo_url IS NULL OR trim(v_from.shop_photo_url) = '' THEN
    RAISE EXCEPTION 'source_photo_missing';
  END IF;
  IF COALESCE(v_from.verification_status, '') = 'pending_location_review' THEN
    RAISE EXCEPTION 'source_pending_location_review';
  END IF;

  -- Copy location + photo proof only. Do NOT copy is_manual_verified or
  -- verification_status from source; set an independent local status.
  UPDATE public.vendor_categories
  SET
    latitude = v_from.latitude,
    longitude = v_from.longitude,
    shop_photo_url = trim(v_from.shop_photo_url),
    gps_match_distance = v_from.gps_match_distance,
    location_accuracy = v_from.location_accuracy,
    photo_accuracy = v_from.photo_accuracy,
    verification_status = 'business_verified',
    is_manual_verified = false
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  -- Compatibility mirror: if account pin empty, adopt this business pin.
  UPDATE public.vendors
  SET
    latitude = COALESCE(latitude, v_from.latitude),
    longitude = COALESCE(longitude, v_from.longitude),
    location_accuracy = COALESCE(location_accuracy, v_from.location_accuracy)
  WHERE id = p_vendor_id
    AND (latitude IS NULL OR longitude IS NULL);
END;
$$;

COMMENT ON FUNCTION public.vendor_inherit_colocated_shop_photo(uuid, text, uuid, uuid) IS
  'Copy shop photo + coords from a co-located business; does not inherit admin green.';

REVOKE ALL ON FUNCTION public.vendor_inherit_colocated_shop_photo(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_inherit_colocated_shop_photo(uuid, text, uuid, uuid)
  TO anon, authenticated, service_role;

-- ── Extend shop photo submit: write per-business lat/lng ────────────────────

DROP FUNCTION IF EXISTS public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision,
  boolean, double precision, double precision, double precision
);

CREATE FUNCTION public.vendor_submit_category_shop_photo(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_shop_photo_url text,
  p_gps_match_distance integer DEFAULT NULL,
  p_set_account_lat double precision DEFAULT NULL,
  p_set_account_lng double precision DEFAULT NULL,
  p_pending_location_review boolean DEFAULT false,
  p_location_accuracy double precision DEFAULT NULL,
  p_photo_accuracy double precision DEFAULT NULL,
  p_set_account_location_accuracy double precision DEFAULT NULL,
  p_business_lat double precision DEFAULT NULL,
  p_business_lng double precision DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz_lat double precision;
  v_biz_lng double precision;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_shop_photo_url IS NULL OR trim(p_shop_photo_url) = '' THEN
    RAISE EXCEPTION 'shop_photo_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendor_categories
    WHERE vendor_id = p_vendor_id AND category_id = p_category_id
  ) THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  -- Resolve business pin: explicit args, else first-time capture via account setters.
  v_biz_lat := p_business_lat;
  v_biz_lng := p_business_lng;
  IF v_biz_lat IS NULL OR v_biz_lng IS NULL THEN
    IF p_set_account_lat IS NOT NULL AND p_set_account_lng IS NOT NULL THEN
      v_biz_lat := p_set_account_lat;
      v_biz_lng := p_set_account_lng;
    END IF;
  END IF;

  -- Account compatibility mirror (primary/first pin only when empty).
  IF p_set_account_lat IS NOT NULL AND p_set_account_lng IS NOT NULL THEN
    UPDATE public.vendors
    SET
      latitude = COALESCE(latitude, p_set_account_lat),
      longitude = COALESCE(longitude, p_set_account_lng),
      location_accuracy = COALESCE(
        location_accuracy,
        COALESCE(p_set_account_location_accuracy, p_photo_accuracy)
      )
    WHERE id = p_vendor_id
      AND (latitude IS NULL OR longitude IS NULL);
  ELSIF p_set_account_location_accuracy IS NOT NULL THEN
    UPDATE public.vendors
    SET location_accuracy = COALESCE(location_accuracy, p_set_account_location_accuracy)
    WHERE id = p_vendor_id;
  END IF;

  IF p_location_accuracy IS NOT NULL THEN
    UPDATE public.vendors
    SET location_accuracy = p_location_accuracy
    WHERE id = p_vendor_id
      AND (location_accuracy IS NULL OR location_accuracy IS DISTINCT FROM p_location_accuracy);
  END IF;

  -- Also mirror from business pin when account still empty.
  IF v_biz_lat IS NOT NULL AND v_biz_lng IS NOT NULL THEN
    UPDATE public.vendors
    SET
      latitude = COALESCE(latitude, v_biz_lat),
      longitude = COALESCE(longitude, v_biz_lng),
      location_accuracy = COALESCE(location_accuracy, p_location_accuracy, p_photo_accuracy)
    WHERE id = p_vendor_id
      AND (latitude IS NULL OR longitude IS NULL);
  END IF;

  UPDATE public.vendor_categories
  SET
    shop_photo_url = trim(p_shop_photo_url),
    gps_match_distance = p_gps_match_distance,
    location_accuracy = p_location_accuracy,
    photo_accuracy = p_photo_accuracy,
    latitude = COALESCE(v_biz_lat, latitude),
    longitude = COALESCE(v_biz_lng, longitude),
    verification_status = CASE
      WHEN COALESCE(p_pending_location_review, false) THEN 'pending_location_review'
      ELSE 'business_verified'
    END,
    is_manual_verified = false
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;
END;
$$;

COMMENT ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision,
  boolean, double precision, double precision, double precision,
  double precision, double precision
) IS
  'Vendor submits per-business shop photo; writes category lat/lng; optional soft-fail.';

REVOKE ALL ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision,
  boolean, double precision, double precision, double precision,
  double precision, double precision
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision,
  boolean, double precision, double precision, double precision,
  double precision, double precision
) TO anon, authenticated, service_role;
