-- GPS match: store accuracy metadata, log failures, soft-fail → pending_location_review.

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS location_accuracy double precision;

COMMENT ON COLUMN public.vendors.location_accuracy IS
  'Horizontal GPS accuracy (meters) reported when shop location was last set.';

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS location_accuracy double precision,
  ADD COLUMN IF NOT EXISTS photo_accuracy double precision;

COMMENT ON COLUMN public.vendor_categories.location_accuracy IS
  'Shop-location GPS accuracy (m) at shop-photo match time.';
COMMENT ON COLUMN public.vendor_categories.photo_accuracy IS
  'Photo-capture GPS accuracy (m) at shop-photo match time.';

-- ── Failure audit (persists even when photo is discarded) ───────────────────

CREATE TABLE IF NOT EXISTS public.gps_match_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  vendor_id uuid REFERENCES public.vendors (id) ON DELETE SET NULL,
  device_id text,
  session_key text,
  source text NOT NULL,
  distance_meters double precision NOT NULL,
  location_accuracy double precision,
  photo_accuracy double precision,
  effective_tolerance double precision NOT NULL
);

COMMENT ON TABLE public.gps_match_failures IS
  'Client GPS shop-photo mismatch attempts (including soft-fail precursors).';

CREATE INDEX IF NOT EXISTS gps_match_failures_created_at_idx
  ON public.gps_match_failures (created_at DESC);
CREATE INDEX IF NOT EXISTS gps_match_failures_vendor_id_idx
  ON public.gps_match_failures (vendor_id)
  WHERE vendor_id IS NOT NULL;

ALTER TABLE public.gps_match_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gps_match_failures_admin_select ON public.gps_match_failures;
CREATE POLICY gps_match_failures_admin_select ON public.gps_match_failures
  FOR SELECT
  USING (public.is_admin_session());

CREATE OR REPLACE FUNCTION public.log_gps_match_failure(
  p_distance_meters double precision,
  p_location_accuracy double precision DEFAULT NULL,
  p_photo_accuracy double precision DEFAULT NULL,
  p_effective_tolerance double precision DEFAULT NULL,
  p_source text DEFAULT 'registration',
  p_vendor_id uuid DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_session_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_tol double precision;
BEGIN
  IF p_distance_meters IS NULL OR p_distance_meters < 0 THEN
    RAISE EXCEPTION 'distance_required';
  END IF;

  v_tol := COALESCE(p_effective_tolerance, 75);

  INSERT INTO public.gps_match_failures (
    vendor_id,
    device_id,
    session_key,
    source,
    distance_meters,
    location_accuracy,
    photo_accuracy,
    effective_tolerance
  )
  VALUES (
    p_vendor_id,
    NULLIF(trim(COALESCE(p_device_id, '')), ''),
    NULLIF(trim(COALESCE(p_session_key, '')), ''),
    COALESCE(NULLIF(trim(p_source), ''), 'registration'),
    p_distance_meters,
    p_location_accuracy,
    p_photo_accuracy,
    v_tol
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.log_gps_match_failure IS
  'Insert a GPS shop-photo mismatch attempt for distribution analysis.';

REVOKE ALL ON FUNCTION public.log_gps_match_failure(
  double precision, double precision, double precision, double precision,
  text, uuid, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_gps_match_failure(
  double precision, double precision, double precision, double precision,
  text, uuid, text, text
) TO anon, authenticated, service_role;

-- ── Shop photo submit: accuracies + pending_location_review soft-fail ───────

DROP FUNCTION IF EXISTS public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision
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
  p_set_account_location_accuracy double precision DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Persist shop-location accuracy from the match when provided.
  IF p_location_accuracy IS NOT NULL THEN
    UPDATE public.vendors
    SET location_accuracy = p_location_accuracy
    WHERE id = p_vendor_id
      AND (location_accuracy IS NULL OR location_accuracy IS DISTINCT FROM p_location_accuracy);
  END IF;

  UPDATE public.vendor_categories
  SET
    shop_photo_url = trim(p_shop_photo_url),
    gps_match_distance = p_gps_match_distance,
    location_accuracy = p_location_accuracy,
    photo_accuracy = p_photo_accuracy,
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
  boolean, double precision, double precision, double precision
) IS
  'Vendor submits per-business shop photo; optional pending_location_review soft-fail.';

REVOKE ALL ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision,
  boolean, double precision, double precision, double precision
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision,
  boolean, double precision, double precision, double precision
) TO anon, authenticated, service_role;

-- ── vendor_update_own: allow location_accuracy with lat/lng updates ─────────

CREATE OR REPLACE FUNCTION public.vendor_update_own(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amber numeric;
  v_red numeric;
BEGIN
  IF p_patch ? 'is_active' AND (p_patch->>'is_active')::boolean IS TRUE THEN
    PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);
    PERFORM public._assert_vendor_photos_ready(p_vendor_id, p_vendor_phone);
  END IF;

  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'patch_required';
  END IF;

  IF p_patch ? 'discoverable' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  IF p_patch ? 'upi_verified' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  IF p_patch ? 'verification_status' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  IF p_patch ? 'subscription_status'
     OR p_patch ? 'subscription_id'
     OR p_patch ? 'grace_ends_at'
  THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  IF p_patch ? 'khata_amber_limit' OR p_patch ? 'khata_red_limit' THEN
    SELECT
      CASE
        WHEN p_patch ? 'khata_amber_limit' THEN (p_patch->>'khata_amber_limit')::numeric
        ELSE v.khata_amber_limit
      END,
      CASE
        WHEN p_patch ? 'khata_red_limit' THEN (p_patch->>'khata_red_limit')::numeric
        ELSE v.khata_red_limit
      END
    INTO v_amber, v_red
    FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = trim(p_vendor_phone);

    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found_or_unauthorized';
    END IF;

    v_amber := COALESCE(v_amber, 0);
    v_red := COALESCE(v_red, 0);

    IF NOT (v_red = 0 OR (v_red > v_amber AND v_amber >= 0)) THEN
      RAISE EXCEPTION 'khata_limits_invalid';
    END IF;
  END IF;

  IF p_patch ? 'ledger_cycle_start' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.vendors v
      WHERE v.id = p_vendor_id
        AND v.phone = trim(p_vendor_phone)
    ) THEN
      RAISE EXCEPTION 'not_found_or_unauthorized';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.khata_ledger k
      WHERE k.vendor_id = p_vendor_id
        AND k.total_outstanding > 0
    ) THEN
      RAISE EXCEPTION 'ledger_cycle_change_blocked';
    END IF;
  END IF;

  UPDATE public.vendors v
  SET
    name = CASE WHEN p_patch ? 'name' THEN NULLIF(trim(p_patch->>'name'), '') ELSE v.name END,
    vendor_note = CASE WHEN p_patch ? 'vendor_note' THEN NULLIF(p_patch->>'vendor_note', '') ELSE v.vendor_note END,
    service_radius_km = CASE WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::integer ELSE v.service_radius_km END,
    latitude = CASE WHEN p_patch ? 'latitude' THEN (p_patch->>'latitude')::double precision ELSE v.latitude END,
    longitude = CASE WHEN p_patch ? 'longitude' THEN (p_patch->>'longitude')::double precision ELSE v.longitude END,
    location_accuracy = CASE
      WHEN p_patch ? 'location_accuracy' AND p_patch->'location_accuracy' IS NULL THEN NULL
      WHEN p_patch ? 'location_accuracy' THEN (p_patch->>'location_accuracy')::double precision
      ELSE v.location_accuracy
    END,
    profile_status = CASE WHEN p_patch ? 'profile_status' THEN p_patch->>'profile_status' ELSE v.profile_status END,
    ledger_cycle_start = CASE
      WHEN p_patch ? 'ledger_cycle_start' AND p_patch->'ledger_cycle_start' IS NULL THEN NULL
      WHEN p_patch ? 'ledger_cycle_start' THEN (p_patch->>'ledger_cycle_start')::date
      ELSE v.ledger_cycle_start
    END,
    khata_amber_limit = CASE WHEN p_patch ? 'khata_amber_limit' THEN (p_patch->>'khata_amber_limit')::numeric ELSE v.khata_amber_limit END,
    khata_red_limit = CASE WHEN p_patch ? 'khata_red_limit' THEN (p_patch->>'khata_red_limit')::numeric ELSE v.khata_red_limit END,
    cancel_reason_1 = CASE WHEN p_patch ? 'cancel_reason_1' THEN NULLIF(p_patch->>'cancel_reason_1', '') ELSE v.cancel_reason_1 END,
    cancel_reason_2 = CASE WHEN p_patch ? 'cancel_reason_2' THEN NULLIF(p_patch->>'cancel_reason_2', '') ELSE v.cancel_reason_2 END,
    cancel_reason_3 = CASE WHEN p_patch ? 'cancel_reason_3' THEN NULLIF(p_patch->>'cancel_reason_3', '') ELSE v.cancel_reason_3 END,
    cancel_reason_4 = CASE WHEN p_patch ? 'cancel_reason_4' THEN NULLIF(p_patch->>'cancel_reason_4', '') ELSE v.cancel_reason_4 END,
    last_updated = CASE
      WHEN p_patch ? 'last_updated' THEN (p_patch->>'last_updated')::timestamptz
      ELSE v.last_updated
    END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch->>'is_active')::boolean ELSE v.is_active END,
    fcm_token = CASE WHEN p_patch ? 'fcm_token' THEN NULLIF(p_patch->>'fcm_token', '') ELSE v.fcm_token END,
    shop_name = CASE WHEN p_patch ? 'shop_name' THEN NULLIF(p_patch->>'shop_name', '') ELSE v.shop_name END,
    category = CASE WHEN p_patch ? 'category' THEN NULLIF(p_patch->>'category', '') ELSE v.category END,
    service_mode = CASE WHEN p_patch ? 'service_mode' THEN NULLIF(p_patch->>'service_mode', '') ELSE v.service_mode END,
    vendor_type = CASE WHEN p_patch ? 'vendor_type' THEN NULLIF(p_patch->>'vendor_type', '') ELSE v.vendor_type END,
    base_type = CASE WHEN p_patch ? 'base_type' THEN NULLIF(p_patch->>'base_type', '') ELSE v.base_type END,
    serves_at_vendor_place = CASE
      WHEN p_patch ? 'serves_at_vendor_place' THEN (p_patch->>'serves_at_vendor_place')::boolean
      ELSE v.serves_at_vendor_place
    END,
    serves_at_customer_place = CASE
      WHEN p_patch ? 'serves_at_customer_place' THEN (p_patch->>'serves_at_customer_place')::boolean
      ELSE v.serves_at_customer_place
    END,
    phone = CASE WHEN p_patch ? 'phone' THEN NULLIF(p_patch->>'phone', '') ELSE v.phone END,
    upi_id = CASE WHEN p_patch ? 'upi_id' THEN NULLIF(p_patch->>'upi_id', '') ELSE v.upi_id END,
    is_manual_verified = CASE WHEN p_patch ? 'is_manual_verified' THEN (p_patch->>'is_manual_verified')::boolean ELSE v.is_manual_verified END,
    verification_status = CASE
      WHEN (
        p_patch ? 'phone'
        AND NULLIF(trim(p_patch->>'phone'), '') IS DISTINCT FROM v.phone
      ) OR (
        p_patch ? 'upi_id'
        AND NULLIF(trim(COALESCE(p_patch->>'upi_id', '')), '')
          IS DISTINCT FROM NULLIF(trim(COALESCE(v.upi_id, '')), '')
      )
      THEN 'identity_linked'
      ELSE v.verification_status
    END,
    shop_photo_url = CASE
      WHEN p_patch ? 'shop_photo_url' AND p_patch->'shop_photo_url' IS NULL THEN NULL
      WHEN p_patch ? 'shop_photo_url' THEN NULLIF(p_patch->>'shop_photo_url', '')
      ELSE v.shop_photo_url
    END,
    upi_verified = CASE
      WHEN p_patch ? 'upi_id'
        AND NULLIF(trim(COALESCE(p_patch->>'upi_id', '')), '')
          IS DISTINCT FROM NULLIF(trim(COALESCE(v.upi_id, '')), '')
      THEN false
      ELSE v.upi_verified
    END,
    photo_selfie = CASE
      WHEN p_patch ? 'photo_selfie' AND p_patch->'photo_selfie' IS NULL THEN NULL
      WHEN p_patch ? 'photo_selfie' THEN NULLIF(p_patch->>'photo_selfie', '')
      ELSE v.photo_selfie
    END,
    gps_match_distance = CASE WHEN p_patch ? 'gps_match_distance' THEN (p_patch->>'gps_match_distance')::integer ELSE v.gps_match_distance END
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_patch ? 'base_type' AND NOT (p_patch ? 'vendor_type') THEN
    UPDATE public.vendors v
    SET vendor_type = CASE v.base_type
      WHEN 'shop' THEN 'shop'
      WHEN 'home' THEN 'home'
      WHEN 'none' THEN 'visiting'
      ELSE v.vendor_type
    END
    WHERE v.id = p_vendor_id
      AND v.phone = trim(p_vendor_phone);
  END IF;

  IF p_patch ? 'shop_name' THEN
    UPDATE public.vendor_categories vc
    SET brand_name = NULLIF(trim(p_patch->>'shop_name'), '')
    WHERE vc.vendor_id = p_vendor_id;
  END IF;
END;
$$;

-- ── Admin can approve pending_location_review ───────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_verify_vendor_category(
  p_admin_phone text,
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT verification_status INTO v_status
  FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF COALESCE(v_status, '') NOT IN (
    'green_pending',
    'business_verified',
    'pending_location_review'
  ) THEN
    RAISE EXCEPTION 'category_not_ready';
  END IF;

  UPDATE public.vendor_categories
  SET
    is_manual_verified = true,
    verification_status = CASE
      WHEN verification_status = 'pending_location_review' THEN 'business_verified'
      ELSE verification_status
    END
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  UPDATE public.vendors v
  SET is_manual_verified = EXISTS (
    SELECT 1 FROM public.vendor_categories vc
    WHERE vc.vendor_id = v.id AND vc.is_manual_verified = true
  )
  WHERE v.id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) IS
  'Admin approval for one business; allows green_pending, business_verified, or pending_location_review.';
