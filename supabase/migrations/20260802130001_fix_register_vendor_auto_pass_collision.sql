-- Fix register_vendor colliding with tier auto-pass triggers:
-- category/vendor triggers insert photo_shop/photo_selfie/gps before register's
-- default 7-row seed. Seed only non-auto checks, then sync auto-managed ones.

CREATE OR REPLACE FUNCTION public.register_vendor(
  p_name text,
  p_shop_name text,
  p_category text,
  p_phone text,
  p_upi_id text,
  p_service_mode text,
  p_vendor_type text,
  p_vendor_note text,
  p_latitude double precision,
  p_longitude double precision,
  p_referral_code text,
  p_profile_status text,
  p_category_ids uuid[],
  p_category_service_modes text[],
  p_category_modes jsonb,
  p_upi_qr_url text DEFAULT NULL,
  p_upi_qr_payee_id text DEFAULT NULL,
  p_base_type text DEFAULT NULL,
  p_serves_at_vendor_place boolean DEFAULT NULL,
  p_serves_at_customer_place boolean DEFAULT NULL,
  p_service_radius_km integer DEFAULT NULL,
  p_availability_modes text[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_needs_review boolean;
  v_cat_count integer;
  i integer;
  v_profile_status text;
  v_base_type text;
  v_vendor_type text;
  v_vc_id uuid;
  v_modes text[];
  v_primary_mode text;
  v_catalog_mode text;
  v_cat_primary text;
BEGIN
  IF NOT public.check_and_log_rate_limit('register_vendor', 'phone', p_phone, 3, 300) THEN
    RAISE EXCEPTION 'rate_limited: too many registration attempts, please wait a few minutes' USING ERRCODE = 'P0001';
  END IF;

  IF trim(p_phone) !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'invalid_phone_format: phone must be a 10-digit Indian mobile number' USING ERRCODE = 'P0001';
  END IF;

  v_base_type := lower(trim(COALESCE(p_base_type, p_vendor_type)));
  IF v_base_type = 'visiting' THEN
    v_base_type := 'none';
  END IF;
  IF v_base_type NOT IN ('shop', 'home', 'none') THEN
    RAISE EXCEPTION 'base_type_required: must be shop, home, or none' USING ERRCODE = 'P0001';
  END IF;

  IF p_serves_at_vendor_place IS NULL OR p_serves_at_customer_place IS NULL THEN
    RAISE EXCEPTION 'reach_required: serves_at_vendor_place and serves_at_customer_place must be set' USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_serves_at_vendor_place AND NOT p_serves_at_customer_place THEN
    RAISE EXCEPTION 'reach_invalid: at least one reach option must be true' USING ERRCODE = 'P0001';
  END IF;

  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'gps_required: latitude and longitude are required' USING ERRCODE = 'P0001';
  END IF;

  IF p_serves_at_customer_place AND (p_service_radius_km IS NULL OR p_service_radius_km <= 0) THEN
    RAISE EXCEPTION 'service_radius_required when serving at customer place' USING ERRCODE = 'P0001';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);
  IF v_cat_count = 0 THEN
    RAISE EXCEPTION 'category_ids_required' USING ERRCODE = 'P0001';
  END IF;

  IF cardinality(p_category_ids)
     <> (SELECT count(DISTINCT x) FROM unnest(p_category_ids) AS x)
  THEN
    RAISE EXCEPTION 'duplicate_category_ids';
  END IF;

  IF p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  PERFORM public._assert_category_modes_map(p_category_ids, p_category_modes);

  v_modes := public._modes_from_category_map(p_category_ids[1], p_category_modes);
  v_primary_mode := public._pick_primary_availability_mode(
    v_modes,
    NULLIF(trim(p_category_service_modes[1]), '')
  );

  v_profile_status := lower(trim(COALESCE(p_profile_status, 'complete')));
  IF v_profile_status NOT IN ('draft', 'complete') THEN
    RAISE EXCEPTION 'profile_status must be draft or complete';
  END IF;

  v_vendor_type := CASE v_base_type
    WHEN 'shop' THEN 'shop'
    WHEN 'home' THEN 'home'
    WHEN 'none' THEN 'visiting'
    ELSE trim(p_vendor_type)
  END;

  v_needs_review := v_cat_count >= 3;

  INSERT INTO public.vendors (
    name, shop_name, category, phone, upi_id, upi_qr_url, upi_qr_payee_id,
    is_active, service_mode, vendor_type, base_type,
    serves_at_vendor_place, serves_at_customer_place, service_radius_km,
    vendor_note, latitude, longitude, verification_status, upi_verified,
    is_manual_verified, shop_photo_url, photo_selfie, referral_code, profile_status
  )
  VALUES (
    trim(p_name), trim(p_shop_name), trim(p_category), trim(p_phone), trim(p_upi_id),
    NULLIF(trim(p_upi_qr_url), ''), NULLIF(trim(p_upi_qr_payee_id), ''),
    false, v_primary_mode, v_vendor_type, v_base_type,
    p_serves_at_vendor_place, p_serves_at_customer_place,
    COALESCE(p_service_radius_km, 15),
    NULLIF(trim(p_vendor_note), ''), p_latitude, p_longitude,
    'identity_linked', false, false, NULL, NULL,
    upper(trim(p_referral_code)), v_profile_status
  )
  RETURNING id INTO v_vendor_id;

  FOR i IN 1..v_cat_count LOOP
    SELECT c.service_mode INTO v_catalog_mode
    FROM public.categories c WHERE c.id = p_category_ids[i];

    v_modes := public._modes_from_category_map(p_category_ids[i], p_category_modes);
    v_cat_primary := public._pick_primary_availability_mode(
      v_modes,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), v_catalog_mode)
    );

    INSERT INTO public.vendor_categories (
      vendor_id, category_id, is_primary, status, needs_review, service_mode
    )
    VALUES (
      v_vendor_id, p_category_ids[i], i = 1, 'approved', v_needs_review, v_cat_primary
    )
    RETURNING id INTO v_vc_id;

    PERFORM public._rewrite_vendor_category_modes(v_vc_id, v_modes, v_catalog_mode);
  END LOOP;

  PERFORM public._derive_vendor_availability_modes(v_vendor_id);

  -- Non-auto checks only. photo_shop / photo_selfie / gps are owned by
  -- sync_vendor_tier_auto_checks (may already exist from INSERT triggers).
  INSERT INTO public.vendor_verification (
    vendor_id, check_type, status, checked_by, is_latest
  )
  VALUES
    (v_vendor_id, 'upi_format', 'passed', 'system', true),
    (v_vendor_id, 'upi_pennydrop', 'dormant', 'system', true),
    (v_vendor_id, 'aadhaar_digilocker', 'dormant', 'system', true),
    (v_vendor_id, 'admin_check', 'dormant', 'system', true);

  PERFORM public.sync_vendor_tier_auto_checks(v_vendor_id);

  RETURN v_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], jsonb, text, text,
  text, boolean, boolean, integer, text[]
) IS
  'Atomic vendor registration with per-category availability modes. Auto-pass Bronze photo/gps checks via sync_vendor_tier_auto_checks.';
