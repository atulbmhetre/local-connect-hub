-- Vendor registration wizard: base_type, reach flags, multi-mode categories, availability modes.

-- ── vendors: base_type + customer reach flags ────────────────────────────────

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS base_type text,
  ADD COLUMN IF NOT EXISTS serves_at_vendor_place boolean,
  ADD COLUMN IF NOT EXISTS serves_at_customer_place boolean;

COMMENT ON COLUMN public.vendors.base_type IS
  'Where the vendor works from: shop | home | none (mobile / no fixed base). Synced to vendor_type (none → visiting).';

-- Backfill existing rows before NOT NULL enforcement on new registrations via RPC.
UPDATE public.vendors
SET base_type = CASE
  WHEN vendor_type = 'shop' THEN 'shop'
  WHEN vendor_type = 'home' THEN 'home'
  ELSE 'none'
END
WHERE base_type IS NULL;

UPDATE public.vendors
SET
  serves_at_vendor_place = CASE
    WHEN vendor_type IN ('shop', 'home') THEN true
    ELSE false
  END,
  serves_at_customer_place = CASE
    WHEN vendor_type = 'visiting' THEN true
    WHEN vendor_type = 'home' THEN true
    ELSE false
  END
WHERE serves_at_vendor_place IS NULL OR serves_at_customer_place IS NULL;

ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_reach_at_least_one_chk
  CHECK (
    serves_at_vendor_place IS NULL
    OR serves_at_customer_place IS NULL
    OR serves_at_vendor_place = true
    OR serves_at_customer_place = true
  );

ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_base_type_chk
  CHECK (base_type IS NULL OR base_type IN ('shop', 'home', 'none'));

-- ── vendor_category_modes: multiple modes per category row ───────────────────

CREATE TABLE IF NOT EXISTS public.vendor_category_modes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_category_id uuid NOT NULL REFERENCES public.vendor_categories(id) ON DELETE CASCADE,
  mode text NOT NULL,
  CONSTRAINT vendor_category_modes_mode_chk
    CHECK (mode IN ('help', 'delivery', 'appointment')),
  CONSTRAINT vendor_category_modes_unique UNIQUE (vendor_category_id, mode)
);

CREATE INDEX IF NOT EXISTS vendor_category_modes_vc_id_idx
  ON public.vendor_category_modes (vendor_category_id);

CREATE INDEX IF NOT EXISTS vendor_category_modes_mode_idx
  ON public.vendor_category_modes (mode);

ALTER TABLE public.vendor_category_modes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read vendor category modes" ON public.vendor_category_modes;
CREATE POLICY "Public can read vendor category modes"
  ON public.vendor_category_modes FOR SELECT
  USING (true);

-- Backfill one mode per existing vendor_categories row.
INSERT INTO public.vendor_category_modes (vendor_category_id, mode)
SELECT vc.id, vc.service_mode
FROM public.vendor_categories vc
WHERE vc.service_mode IS NOT NULL
  AND trim(vc.service_mode) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.vendor_category_modes m WHERE m.vendor_category_id = vc.id
  )
ON CONFLICT DO NOTHING;

-- ── vendor_availability_modes: vendor-level availability (wizard page 2) ───────

CREATE TABLE IF NOT EXISTS public.vendor_availability_modes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  mode text NOT NULL,
  CONSTRAINT vendor_availability_modes_mode_chk
    CHECK (mode IN ('help', 'delivery', 'appointment')),
  CONSTRAINT vendor_availability_modes_unique UNIQUE (vendor_id, mode)
);

CREATE INDEX IF NOT EXISTS vendor_availability_modes_vendor_id_idx
  ON public.vendor_availability_modes (vendor_id);

ALTER TABLE public.vendor_availability_modes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read vendor availability modes" ON public.vendor_availability_modes;
CREATE POLICY "Public can read vendor availability modes"
  ON public.vendor_availability_modes FOR SELECT
  USING (true);

INSERT INTO public.vendor_availability_modes (vendor_id, mode)
SELECT v.id, v.service_mode
FROM public.vendors v
WHERE v.service_mode IS NOT NULL
  AND trim(v.service_mode) IN ('help', 'delivery', 'appointment')
  AND NOT EXISTS (
    SELECT 1 FROM public.vendor_availability_modes m WHERE m.vendor_id = v.id
  )
ON CONFLICT DO NOTHING;

-- ── vendor_update_own: allow new patch fields ────────────────────────────────

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
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'patch_required';
  END IF;

  IF p_patch ? 'discoverable' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  UPDATE public.vendors v
  SET
    vendor_note = CASE WHEN p_patch ? 'vendor_note' THEN NULLIF(p_patch->>'vendor_note', '') ELSE v.vendor_note END,
    service_radius_km = CASE WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::integer ELSE v.service_radius_km END,
    latitude = CASE WHEN p_patch ? 'latitude' THEN (p_patch->>'latitude')::double precision ELSE v.latitude END,
    longitude = CASE WHEN p_patch ? 'longitude' THEN (p_patch->>'longitude')::double precision ELSE v.longitude END,
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
    subscription_status = CASE WHEN p_patch ? 'subscription_status' THEN p_patch->>'subscription_status' ELSE v.subscription_status END,
    subscription_id = CASE WHEN p_patch ? 'subscription_id' THEN NULLIF(p_patch->>'subscription_id', '') ELSE v.subscription_id END,
    grace_ends_at = CASE
      WHEN p_patch ? 'grace_ends_at' AND p_patch->'grace_ends_at' IS NULL THEN NULL
      WHEN p_patch ? 'grace_ends_at' THEN (p_patch->>'grace_ends_at')::timestamptz
      ELSE v.grace_ends_at
    END,
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
    verification_status = CASE WHEN p_patch ? 'verification_status' THEN p_patch->>'verification_status' ELSE v.verification_status END,
    shop_photo_url = CASE
      WHEN p_patch ? 'shop_photo_url' AND p_patch->'shop_photo_url' IS NULL THEN NULL
      WHEN p_patch ? 'shop_photo_url' THEN NULLIF(p_patch->>'shop_photo_url', '')
      ELSE v.shop_photo_url
    END,
    upi_verified = CASE WHEN p_patch ? 'upi_verified' THEN (p_patch->>'upi_verified')::boolean ELSE v.upi_verified END,
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

  -- Keep vendor_type in sync when base_type is patched.
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
END;
$$;

-- ── vendor_update_availability_modes ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_update_availability_modes(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_modes text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode text;
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

  IF p_modes IS NULL OR COALESCE(array_length(p_modes, 1), 0) = 0 THEN
    RAISE EXCEPTION 'availability_modes_required';
  END IF;

  FOREACH v_mode IN ARRAY p_modes LOOP
    IF v_mode NOT IN ('help', 'delivery', 'appointment') THEN
      RAISE EXCEPTION 'invalid_availability_mode: %', v_mode;
    END IF;
  END LOOP;

  DELETE FROM public.vendor_availability_modes WHERE vendor_id = p_vendor_id;

  FOREACH v_mode IN ARRAY p_modes LOOP
    INSERT INTO public.vendor_availability_modes (vendor_id, mode)
    VALUES (p_vendor_id, v_mode)
    ON CONFLICT DO NOTHING;
  END LOOP;

  UPDATE public.vendors
  SET service_mode = p_modes[1]
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_availability_modes(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_availability_modes(uuid, text, text[]) TO anon, authenticated;

-- ── vendor_sync_category_modes: apply vendor availability modes to all category rows ─

CREATE OR REPLACE FUNCTION public.vendor_sync_category_modes(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_modes text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vc record;
  v_mode text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_modes IS NULL OR COALESCE(array_length(p_modes, 1), 0) = 0 THEN
    RAISE EXCEPTION 'availability_modes_required';
  END IF;

  FOR v_vc IN
    SELECT id FROM public.vendor_categories WHERE vendor_id = p_vendor_id
  LOOP
    DELETE FROM public.vendor_category_modes WHERE vendor_category_id = v_vc.id;
    FOREACH v_mode IN ARRAY p_modes LOOP
      INSERT INTO public.vendor_category_modes (vendor_category_id, mode)
      VALUES (v_vc.id, v_mode)
      ON CONFLICT DO NOTHING;
    END LOOP;
    UPDATE public.vendor_categories
    SET service_mode = p_modes[1]
    WHERE id = v_vc.id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_sync_category_modes(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_sync_category_modes(uuid, text, text[]) TO anon, authenticated;

-- ── register_vendor (extended) ───────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], text, text
);

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
  v_mode text;
  v_primary_mode text;
  v_modes text[];
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

  v_modes := p_availability_modes;
  IF v_modes IS NULL OR COALESCE(array_length(v_modes, 1), 0) = 0 THEN
    RAISE EXCEPTION 'availability_modes_required' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_mode IN ARRAY v_modes LOOP
    IF v_mode NOT IN ('help', 'delivery', 'appointment') THEN
      RAISE EXCEPTION 'invalid_availability_mode: %', v_mode;
    END IF;
  END LOOP;

  v_primary_mode := v_modes[1];

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

  IF p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

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
    base_type,
    serves_at_vendor_place,
    serves_at_customer_place,
    service_radius_km,
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
    v_primary_mode,
    v_vendor_type,
    v_base_type,
    p_serves_at_vendor_place,
    p_serves_at_customer_place,
    COALESCE(p_service_radius_km, 15),
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

  FOREACH v_mode IN ARRAY v_modes LOOP
    INSERT INTO public.vendor_availability_modes (vendor_id, mode)
    VALUES (v_vendor_id, v_mode)
    ON CONFLICT DO NOTHING;
  END LOOP;

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
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), v_primary_mode)
    )
    RETURNING id INTO v_vc_id;

    FOREACH v_mode IN ARRAY v_modes LOOP
      INSERT INTO public.vendor_category_modes (vendor_category_id, mode)
      VALUES (v_vc_id, v_mode)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

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
  double precision, double precision, text, text, uuid[], text[], text, text,
  text, boolean, boolean, integer, text[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], text, text,
  text, boolean, boolean, integer, text[]
) TO anon, authenticated;

COMMENT ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], text, text,
  text, boolean, boolean, integer, text[]
) IS
  'Atomic vendor registration with base_type, reach flags, availability modes, and vendor_category_modes. GPS required. Rate-limited by phone.';
