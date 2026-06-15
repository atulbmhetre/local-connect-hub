-- VR-REG-01/02/03: Atomic vendor registration (vendors + vendor_categories + vendor_verification).

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
  p_category_ids uuid[],
  p_category_service_modes text[]
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
BEGIN
  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);

  IF v_cat_count > 0 AND (
    p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  ) THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  v_needs_review := v_cat_count >= 3;

  INSERT INTO public.vendors (
    name,
    shop_name,
    category,
    phone,
    upi_id,
    is_active,
    service_mode,
    vendor_type,
    vendor_note,
    latitude,
    longitude,
    verification_status,
    upi_verified,
    is_manual_verified,
    shop_photo_url,
    photo_selfie,
    referral_code
  )
  VALUES (
    trim(p_name),
    trim(p_shop_name),
    trim(p_category),
    trim(p_phone),
    trim(p_upi_id),
    false,
    trim(p_service_mode),
    trim(p_vendor_type),
    NULLIF(trim(p_vendor_note), ''),
    p_latitude,
    p_longitude,
    'identity_linked',
    false,
    false,
    NULL,
    NULL,
    upper(trim(p_referral_code))
  )
  RETURNING id INTO v_vendor_id;

  IF v_cat_count > 0 THEN
    FOR i IN 1..v_cat_count LOOP
      INSERT INTO public.vendor_categories (
        vendor_id,
        category_id,
        is_primary,
        status,
        needs_review,
        service_mode
      )
      VALUES (
        v_vendor_id,
        p_category_ids[i],
        i = 1,
        'approved',
        v_needs_review,
        COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), trim(p_service_mode))
      );
    END LOOP;
  END IF;

  INSERT INTO public.vendor_verification (
    vendor_id, check_type, status, checked_by, is_latest
  )
  VALUES
    (v_vendor_id, 'upi_format', 'passed', 'system', true),
    (v_vendor_id, 'upi_pennydrop', 'dormant', 'system', true),
    (v_vendor_id, 'aadhaar_digilocker', 'dormant', 'system', true),
    (v_vendor_id, 'photo_shop', 'dormant', 'system', true),
    (v_vendor_id, 'photo_selfie', 'dormant', 'system', true),
    (v_vendor_id, 'gps', 'dormant', 'system', true),
    (v_vendor_id, 'admin_check', 'dormant', 'system', true);

  RETURN v_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, uuid[], text[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, uuid[], text[]
) TO anon, authenticated;

COMMENT ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, uuid[], text[]
) IS
  'Atomically creates vendor row, vendor_categories, and 7 verification checks. VR-REG-01/02.';
