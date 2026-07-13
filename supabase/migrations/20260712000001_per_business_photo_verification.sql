-- Per-business (vendor_categories) shop-photo verification + trust fields.
-- Account-level vendors.latitude/longitude remain the GPS gate target.
-- Part O brand/reach/radius columns are assumed present.

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS vendor_note text,
  ADD COLUMN IF NOT EXISTS shop_photo_url text,
  ADD COLUMN IF NOT EXISTS gps_match_distance integer,
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS is_manual_verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.vendor_categories.vendor_note IS
  'Per-business vendor note shown to customers for this category.';
COMMENT ON COLUMN public.vendor_categories.shop_photo_url IS
  'Per-business shop photo; GPS-gated at capture against account vendors.lat/lng.';
COMMENT ON COLUMN public.vendor_categories.gps_match_distance IS
  'Meters between capture GPS and account shop location at photo submit time.';
COMMENT ON COLUMN public.vendor_categories.verification_status IS
  'Automatic tier for this business (e.g. business_verified); green badge uses is_manual_verified.';
COMMENT ON COLUMN public.vendor_categories.is_manual_verified IS
  'Admin-approved green/Verified badge for this business only.';

-- Backfill from account-level vendor verification (same inheritance pattern as Part O).
UPDATE public.vendor_categories vc
SET
  vendor_note = COALESCE(vc.vendor_note, NULLIF(trim(v.vendor_note), '')),
  shop_photo_url = COALESCE(vc.shop_photo_url, NULLIF(trim(v.shop_photo_url), '')),
  gps_match_distance = COALESCE(vc.gps_match_distance, v.gps_match_distance),
  verification_status = COALESCE(
    NULLIF(trim(vc.verification_status), ''),
    NULLIF(trim(v.verification_status), '')
  ),
  is_manual_verified = COALESCE(vc.is_manual_verified, false)
    OR COALESCE(v.is_manual_verified, false)
FROM public.vendors v
WHERE vc.vendor_id = v.id;

-- ── Vendor: submit shop photo verification for one business ─────────────────

CREATE OR REPLACE FUNCTION public.vendor_submit_category_shop_photo(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_shop_photo_url text,
  p_gps_match_distance integer DEFAULT NULL,
  p_set_account_lat double precision DEFAULT NULL,
  p_set_account_lng double precision DEFAULT NULL
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

  -- Optional: first-ever location from photo capture (account-level).
  IF p_set_account_lat IS NOT NULL AND p_set_account_lng IS NOT NULL THEN
    UPDATE public.vendors
    SET
      latitude = COALESCE(latitude, p_set_account_lat),
      longitude = COALESCE(longitude, p_set_account_lng)
    WHERE id = p_vendor_id
      AND (latitude IS NULL OR longitude IS NULL);
  END IF;

  UPDATE public.vendor_categories
  SET
    shop_photo_url = trim(p_shop_photo_url),
    gps_match_distance = p_gps_match_distance,
    verification_status = 'business_verified',
    is_manual_verified = false
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_submit_category_shop_photo(
  uuid, text, uuid, text, integer, double precision, double precision
) TO anon, authenticated;

-- Patch per-business note / brand extras without full category replace.
CREATE OR REPLACE FUNCTION public.vendor_update_category_profile(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_patch jsonb
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
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.vendor_categories vc
  SET
    brand_name = CASE
      WHEN p_patch ? 'brand_name' THEN NULLIF(trim(p_patch->>'brand_name'), '')
      ELSE vc.brand_name
    END,
    vendor_note = CASE
      WHEN p_patch ? 'vendor_note' THEN NULLIF(trim(p_patch->>'vendor_note'), '')
      ELSE vc.vendor_note
    END,
    serves_at_vendor_place = CASE
      WHEN p_patch ? 'serves_at_vendor_place' THEN (p_patch->>'serves_at_vendor_place')::boolean
      ELSE vc.serves_at_vendor_place
    END,
    serves_at_customer_place = CASE
      WHEN p_patch ? 'serves_at_customer_place' THEN (p_patch->>'serves_at_customer_place')::boolean
      ELSE vc.serves_at_customer_place
    END,
    service_radius_km = CASE
      WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::numeric
      ELSE vc.service_radius_km
    END
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb)
  TO anon, authenticated;

-- ── Admin: verify / unverify one business ───────────────────────────────────

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
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  UPDATE public.vendor_categories
  SET is_manual_verified = true
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  -- Keep account flag true if any business is admin-verified (legacy readers).
  UPDATE public.vendors v
  SET is_manual_verified = EXISTS (
    SELECT 1 FROM public.vendor_categories vc
    WHERE vc.vendor_id = v.id AND vc.is_manual_verified = true
  )
  WHERE v.id = p_vendor_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unverify_vendor_category(
  p_admin_phone text,
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  UPDATE public.vendor_categories
  SET
    is_manual_verified = false,
    verification_status = CASE
      WHEN verification_status = 'green_pending' THEN 'business_verified'
      ELSE verification_status
    END
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  UPDATE public.vendors v
  SET is_manual_verified = EXISTS (
    SELECT 1 FROM public.vendor_categories vc
    WHERE vc.vendor_id = v.id AND vc.is_manual_verified = true
  )
  WHERE v.id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid)
  TO anon, authenticated;

-- Promote green_pending per business when photo present (account UPI still required).
CREATE OR REPLACE FUNCTION public.vendor_promote_category_green_pending(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upi boolean;
BEGIN
  SELECT COALESCE(upi_verified, false) INTO v_upi
  FROM public.vendors WHERE id = p_vendor_id;
  IF NOT COALESCE(v_upi, false) THEN
    RETURN;
  END IF;

  UPDATE public.vendor_categories
  SET verification_status = 'green_pending'
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id
    AND is_manual_verified = false
    AND shop_photo_url IS NOT NULL
    AND trim(shop_photo_url) <> ''
    AND COALESCE(verification_status, '') IS DISTINCT FROM 'green_pending';
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_promote_category_green_pending(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_promote_category_green_pending(uuid, uuid)
  TO anon, authenticated;

-- Clear per-business photo verification when account GPS is changed.
CREATE OR REPLACE FUNCTION public.vendor_clear_category_photo_verifications(
  p_vendor_id uuid,
  p_vendor_phone text
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
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.vendor_categories
  SET
    shop_photo_url = NULL,
    gps_match_distance = NULL,
    verification_status = 'identity_linked',
    is_manual_verified = false
  WHERE vendor_id = p_vendor_id;

  UPDATE public.vendors
  SET is_manual_verified = false
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_clear_category_photo_verifications(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_clear_category_photo_verifications(uuid, text)
  TO anon, authenticated;

-- Storage buckets for per-business shop photos and account selfies (may already exist in some envs).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'shop-photos',
    'shop-photos',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
  ),
  (
    'vendor-selfies',
    'vendor-selfies',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
  )
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Anon upload shop photos" ON storage.objects;
DROP POLICY IF EXISTS "Anon update shop photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read shop photos" ON storage.objects;
DROP POLICY IF EXISTS "Anon upload vendor selfies" ON storage.objects;
DROP POLICY IF EXISTS "Anon update vendor selfies" ON storage.objects;
DROP POLICY IF EXISTS "Public read vendor selfies" ON storage.objects;

CREATE POLICY "Anon upload shop photos"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'shop-photos');

CREATE POLICY "Anon update shop photos"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'shop-photos')
WITH CHECK (bucket_id = 'shop-photos');

CREATE POLICY "Public read shop photos"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'shop-photos');

CREATE POLICY "Anon upload vendor selfies"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'vendor-selfies');

CREATE POLICY "Anon update vendor selfies"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'vendor-selfies')
WITH CHECK (bucket_id = 'vendor-selfies');

CREATE POLICY "Public read vendor selfies"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'vendor-selfies');
