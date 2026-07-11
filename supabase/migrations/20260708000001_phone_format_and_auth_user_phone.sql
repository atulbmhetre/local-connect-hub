-- Phone format: normalize fixable legacy rows, enforce 10-digit Indian mobile on new writes,
-- validate register_vendor input, and harden auth_user_phone() for 91-prefixed auth.users.phone.

-- ── 0. Normalize fixable legacy phone values (vendors + users) ───────────────

UPDATE public.vendors
SET phone = regexp_replace(phone, '\D', '', 'g')
WHERE phone IS NOT NULL
  AND phone !~ '^[6-9][0-9]{9}$'
  AND phone NOT LIKE 'deleted_%'
  AND phone ~ '\D';

UPDATE public.users
SET phone = regexp_replace(phone, '\D', '', 'g')
WHERE phone IS NOT NULL
  AND phone !~ '^[6-9][0-9]{9}$'
  AND phone NOT LIKE 'deleted_%'
  AND phone ~ '\D';

UPDATE public.vendors
SET phone = substring(phone FROM 3)
WHERE phone ~ '^91[6-9][0-9]{9}$';

UPDATE public.users
SET phone = substring(phone FROM 3)
WHERE phone ~ '^91[6-9][0-9]{9}$';

UPDATE public.vendors
SET phone = right(phone, 10)
WHERE length(phone) = 11
  AND right(phone, 10) ~ '^[6-9][0-9]{9}$'
  AND phone !~ '^[6-9][0-9]{9}$';

UPDATE public.users
SET phone = right(phone, 10)
WHERE length(phone) = 11
  AND right(phone, 10) ~ '^[6-9][0-9]{9}$'
  AND phone !~ '^[6-9][0-9]{9}$';

-- ── 1. CHECK constraints (NOT VALID: existing bad rows remain until cleaned; new rows enforced) ─

ALTER TABLE public.vendors
  DROP CONSTRAINT IF EXISTS vendors_phone_format_check;

ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_phone_format_check
  CHECK (phone ~ '^[6-9][0-9]{9}$' OR phone LIKE 'deleted_%')
  NOT VALID;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_phone_format_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_phone_format_check
  CHECK (phone ~ '^[6-9][0-9]{9}$' OR phone LIKE 'deleted_%')
  NOT VALID;

COMMENT ON CONSTRAINT vendors_phone_format_check ON public.vendors IS
  '10-digit Indian mobile, or deleted_* anonymization tag. NOT VALID until legacy rows are cleaned; run VALIDATE CONSTRAINT after cleanup.';

COMMENT ON CONSTRAINT users_phone_format_check ON public.users IS
  '10-digit Indian mobile, or deleted_* anonymization tag. NOT VALID until legacy rows are cleaned; run VALIDATE CONSTRAINT after cleanup.';

-- ── 2. register_vendor: reject invalid phone before insert ───────────────────

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
  p_upi_qr_url text DEFAULT NULL,
  p_upi_qr_payee_id text DEFAULT NULL
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
BEGIN
  IF NOT public.check_and_log_rate_limit('register_vendor', 'phone', p_phone, 3, 300) THEN
    RAISE EXCEPTION 'rate_limited: too many registration attempts, please wait a few minutes' USING ERRCODE = 'P0001';
  END IF;

  IF trim(p_phone) !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'invalid_phone_format: phone must be a 10-digit Indian mobile number' USING ERRCODE = 'P0001';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);

  IF v_cat_count > 0 AND (
    p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  ) THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  v_profile_status := lower(trim(COALESCE(p_profile_status, 'complete')));
  IF v_profile_status NOT IN ('draft', 'complete') THEN
    RAISE EXCEPTION 'profile_status must be draft or complete';
  END IF;

  v_needs_review := v_cat_count >= 3;

  INSERT INTO public.vendors (
    name,
    shop_name,
    category,
    phone,
    upi_id,
    upi_qr_url,
    upi_qr_payee_id,
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
    referral_code,
    profile_status
  )
  VALUES (
    trim(p_name),
    trim(p_shop_name),
    trim(p_category),
    trim(p_phone),
    trim(p_upi_id),
    NULLIF(trim(p_upi_qr_url), ''),
    NULLIF(trim(p_upi_qr_payee_id), ''),
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
    upper(trim(p_referral_code)),
    v_profile_status
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
  double precision, double precision, text, text, uuid[], text[], text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], text, text
) TO anon, authenticated;

COMMENT ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], text, text
) IS
  'Atomically creates vendor row, vendor_categories, and 7 verification checks. Validates 10-digit phone. Rate-limited by phone.';

-- ── 3. auth_user_phone: strip 91 prefix when stored value is country code + 10 digits ─

CREATE OR REPLACE FUNCTION public.auth_user_phone()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN phone LIKE '91%' AND length(regexp_replace(phone, '\D', '', 'g')) = 12
    THEN right(regexp_replace(phone, '\D', '', 'g'), 10)
    ELSE phone
  END
  FROM auth.users
  WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.auth_user_phone() IS
  'Returns 10-digit app phone from auth.users.phone: strips leading 91 when digits are 12 chars (91 + mobile). Raw 10-digit values pass through unchanged.';
