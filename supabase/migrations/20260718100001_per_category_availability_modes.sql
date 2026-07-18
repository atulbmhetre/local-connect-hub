-- Per-category availability modes: authoritative discovery membership,
-- ID-preserving category reconciliation, Radar membership RPC, and
-- immutable request service_mode for bill/fulfil gating.

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 0. Preflight cleanup for uniqueness constraints
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

-- Keep the oldest row per (vendor_id, category_id); drop newer duplicates.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY vendor_id, category_id
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM public.vendor_categories
)
DELETE FROM public.vendor_categories vc
USING ranked r
WHERE vc.id = r.id
  AND r.rn > 1;

-- Ensure at most one primary per vendor (prefer existing primary, else oldest).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY vendor_id
      ORDER BY is_primary DESC NULLS LAST, created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM public.vendor_categories
)
UPDATE public.vendor_categories vc
SET is_primary = (r.rn = 1)
FROM ranked r
WHERE vc.id = r.id;

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 1. Indexes
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

CREATE UNIQUE INDEX IF NOT EXISTS vendor_categories_vendor_category_uidx
  ON public.vendor_categories (vendor_id, category_id);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_categories_one_primary_uidx
  ON public.vendor_categories (vendor_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS vendor_category_modes_mode_vc_idx
  ON public.vendor_category_modes (mode, vendor_category_id);

CREATE INDEX IF NOT EXISTS vendor_categories_approved_category_lookup_idx
  ON public.vendor_categories (category_id, id, vendor_id)
  WHERE status = 'approved';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 2. Shared helpers
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

CREATE OR REPLACE FUNCTION public._normalize_availability_modes(p_modes text[])
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_out text[] := ARRAY[]::text[];
  v_mode text;
BEGIN
  IF p_modes IS NULL THEN
    RETURN v_out;
  END IF;
  FOREACH v_mode IN ARRAY ARRAY['help', 'delivery', 'appointment'] LOOP
    IF v_mode = ANY (p_modes) THEN
      v_out := array_append(v_out, v_mode);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public._pick_primary_availability_mode(
  p_modes text[],
  p_catalog_mode text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_modes text[] := public._normalize_availability_modes(p_modes);
  v_catalog text := lower(trim(COALESCE(p_catalog_mode, '')));
BEGIN
  IF COALESCE(array_length(v_modes, 1), 0) = 0 THEN
    RETURN 'help';
  END IF;
  IF v_catalog IN ('help', 'delivery', 'appointment') AND v_catalog = ANY (v_modes) THEN
    RETURN v_catalog;
  END IF;
  RETURN v_modes[1];
END;
$$;

CREATE OR REPLACE FUNCTION public._assert_category_modes_map(
  p_category_ids uuid[],
  p_category_modes jsonb
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_key text;
  v_modes text[];
  v_raw jsonb;
  v_elem text;
BEGIN
  IF p_category_modes IS NULL OR jsonb_typeof(p_category_modes) <> 'object' THEN
    RAISE EXCEPTION 'category_modes_required';
  END IF;

  FOREACH v_id IN ARRAY p_category_ids LOOP
    v_key := v_id::text;
    IF NOT (p_category_modes ? v_key) THEN
      RAISE EXCEPTION 'category_modes_missing: %', v_key;
    END IF;
    v_raw := p_category_modes -> v_key;
    IF jsonb_typeof(v_raw) <> 'array' OR jsonb_array_length(v_raw) = 0 THEN
      RAISE EXCEPTION 'category_modes_empty: %', v_key;
    END IF;
    v_modes := ARRAY[]::text[];
    FOR v_elem IN SELECT jsonb_array_elements_text(v_raw) LOOP
      IF lower(trim(v_elem)) NOT IN ('help', 'delivery', 'appointment') THEN
        RAISE EXCEPTION 'invalid_availability_mode: %', v_elem;
      END IF;
      v_modes := array_append(v_modes, lower(trim(v_elem)));
    END LOOP;
    IF COALESCE(array_length(public._normalize_availability_modes(v_modes), 1), 0) = 0 THEN
      RAISE EXCEPTION 'category_modes_empty: %', v_key;
    END IF;
  END LOOP;

  FOR v_key IN SELECT jsonb_object_keys(p_category_modes) LOOP
    IF NOT (v_key::uuid = ANY (p_category_ids)) THEN
      RAISE EXCEPTION 'category_modes_extra: %', v_key;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public._modes_from_category_map(
  p_category_id uuid,
  p_category_modes jsonb
)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public._normalize_availability_modes(
    COALESCE(
      (
        SELECT array_agg(lower(trim(x)))
        FROM jsonb_array_elements_text(p_category_modes -> p_category_id::text) AS t(x)
      ),
      ARRAY[]::text[]
    )
  );
$$;

CREATE OR REPLACE FUNCTION public._rewrite_vendor_category_modes(
  p_vendor_category_id uuid,
  p_modes text[],
  p_catalog_mode text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_modes text[] := public._normalize_availability_modes(p_modes);
  v_primary text;
  v_mode text;
BEGIN
  IF COALESCE(array_length(v_modes, 1), 0) = 0 THEN
    RAISE EXCEPTION 'availability_modes_required';
  END IF;

  v_primary := public._pick_primary_availability_mode(v_modes, p_catalog_mode);

  DELETE FROM public.vendor_category_modes
  WHERE vendor_category_id = p_vendor_category_id;

  FOREACH v_mode IN ARRAY v_modes LOOP
    INSERT INTO public.vendor_category_modes (vendor_category_id, mode)
    VALUES (p_vendor_category_id, v_mode)
    ON CONFLICT DO NOTHING;
  END LOOP;

  UPDATE public.vendor_categories
  SET service_mode = v_primary
  WHERE id = p_vendor_category_id;

  RETURN v_primary;
END;
$$;

CREATE OR REPLACE FUNCTION public._derive_vendor_availability_modes(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_modes text[];
  v_mode text;
  v_primary text;
BEGIN
  SELECT public._normalize_availability_modes(COALESCE(array_agg(vcm.mode), ARRAY[]::text[]))
  INTO v_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id;

  IF COALESCE(array_length(v_modes, 1), 0) = 0 THEN
    SELECT public._normalize_availability_modes(ARRAY[COALESCE(v.service_mode, 'help')])
    INTO v_modes
    FROM public.vendors v
    WHERE v.id = p_vendor_id;
  END IF;

  DELETE FROM public.vendor_availability_modes WHERE vendor_id = p_vendor_id;

  FOREACH v_mode IN ARRAY v_modes LOOP
    INSERT INTO public.vendor_availability_modes (vendor_id, mode)
    VALUES (p_vendor_id, v_mode)
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT vc.service_mode
  INTO v_primary
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
  ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
  LIMIT 1;

  IF v_primary IS NULL THEN
    v_primary := public._pick_primary_availability_mode(v_modes, NULL);
  END IF;

  UPDATE public.vendors
  SET service_mode = v_primary
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public._normalize_availability_modes(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._pick_primary_availability_mode(text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._assert_category_modes_map(uuid[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._modes_from_category_map(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._rewrite_vendor_category_modes(uuid, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._derive_vendor_availability_modes(uuid) FROM PUBLIC;

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 3. Existing-data repair (preserve non-empty child sets; seed empty from scalar)
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

INSERT INTO public.vendor_category_modes (vendor_category_id, mode)
SELECT vc.id, public._pick_primary_availability_mode(ARRAY[COALESCE(vc.service_mode, 'help')], NULL)
FROM public.vendor_categories vc
WHERE NOT EXISTS (
  SELECT 1 FROM public.vendor_category_modes vcm WHERE vcm.vendor_category_id = vc.id
)
ON CONFLICT DO NOTHING;

-- Ensure scalar belongs to child set.
UPDATE public.vendor_categories vc
SET service_mode = sub.primary_mode
FROM (
  SELECT
    vc2.id,
    public._pick_primary_availability_mode(
      COALESCE(array_agg(vcm.mode), ARRAY[COALESCE(vc2.service_mode, 'help')]),
      c.service_mode
    ) AS primary_mode
  FROM public.vendor_categories vc2
  LEFT JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc2.id
  LEFT JOIN public.categories c ON c.id = vc2.category_id
  GROUP BY vc2.id, vc2.service_mode, c.service_mode
) sub
WHERE vc.id = sub.id
  AND vc.service_mode IS DISTINCT FROM sub.primary_mode;

DO $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.vendors LOOP
    PERFORM public._derive_vendor_availability_modes(v_id);
  END LOOP;
END;
$$;

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 4. requests.service_mode (immutable effective mode for the order)
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS service_mode text;

UPDATE public.requests r
SET service_mode = COALESCE(
  (
    SELECT vc.service_mode
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = r.vendor_id
      AND vc.category_id = r.category_id
      AND vc.status = 'approved'
    LIMIT 1
  ),
  (
    SELECT v.service_mode
    FROM public.vendors v
    WHERE v.id = r.vendor_id
  ),
  CASE
    WHEN r.delivery_slot IS NOT NULL THEN 'delivery'
    WHEN r.appointment_time IS NOT NULL THEN 'appointment'
    ELSE 'help'
  END
)
WHERE r.service_mode IS NULL;

ALTER TABLE public.requests
  ALTER COLUMN service_mode SET DEFAULT 'help';

UPDATE public.requests SET service_mode = 'help' WHERE service_mode IS NULL;

ALTER TABLE public.requests
  ALTER COLUMN service_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'requests_service_mode_check'
  ) THEN
    ALTER TABLE public.requests
      ADD CONSTRAINT requests_service_mode_check
      CHECK (service_mode IN ('help', 'delivery', 'appointment'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS requests_service_mode_idx
  ON public.requests (service_mode);

COMMENT ON COLUMN public.requests.service_mode IS
  'Immutable effective mode for this order (help/delivery/appointment). Used for bill/fulfil and UI; not the vendor account primary.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 5. register_vendor â€” accept per-category mode map
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

DROP FUNCTION IF EXISTS public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], text, text,
  text, boolean, boolean, integer, text[]
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
  double precision, double precision, text, text, uuid[], text[], jsonb, text, text,
  text, boolean, boolean, integer, text[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], jsonb, text, text,
  text, boolean, boolean, integer, text[]
) TO anon, authenticated;

COMMENT ON FUNCTION public.register_vendor(
  text, text, text, text, text, text, text, text,
  double precision, double precision, text, text, uuid[], text[], jsonb, text, text,
  text, boolean, boolean, integer, text[]
) IS
  'Atomic vendor registration with per-category availability modes (p_category_modes jsonb). Account availability is derived.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 6. vendor_update_categories â€” ID-preserving + p_category_modes jsonb required
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

DROP FUNCTION IF EXISTS public.vendor_update_categories(uuid, text, uuid[], text[], text[], boolean[], boolean[], numeric[]);

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[],
  p_category_modes jsonb,
  p_brand_names text[] DEFAULT NULL,
  p_serves_at_vendor_place boolean[] DEFAULT NULL,
  p_serves_at_customer_place boolean[] DEFAULT NULL,
  p_service_radius_km numeric[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cat_count integer;
  v_needs_review boolean;
  i integer;
  v_old_ids uuid[];
  v_removed uuid[];
  v_added uuid[];
  v_shop_name text;
  v_new_id uuid;
  v_acct_brand text;
  v_acct_vendor_place boolean;
  v_acct_customer_place boolean;
  v_acct_radius numeric;
  v_brand text;
  v_vendor_place boolean;
  v_customer_place boolean;
  v_radius numeric;
  v_vc_id uuid;
  v_modes text[];
  v_catalog_mode text;
  v_cat_primary text;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  PERFORM 1
  FROM public.vendors
  WHERE id = p_vendor_id
    AND phone = trim(p_vendor_phone)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);
  IF v_cat_count = 0 THEN
    RAISE EXCEPTION 'category_ids_required';
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

  IF p_brand_names IS NOT NULL
    AND COALESCE(array_length(p_brand_names, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'brand_names length must match category_ids length';
  END IF;
  IF p_serves_at_vendor_place IS NOT NULL
    AND COALESCE(array_length(p_serves_at_vendor_place, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'serves_at_vendor_place length must match category_ids length';
  END IF;
  IF p_serves_at_customer_place IS NOT NULL
    AND COALESCE(array_length(p_serves_at_customer_place, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'serves_at_customer_place length must match category_ids length';
  END IF;
  IF p_service_radius_km IS NOT NULL
    AND COALESCE(array_length(p_service_radius_km, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'service_radius_km length must match category_ids length';
  END IF;

  PERFORM public._assert_category_modes_map(p_category_ids, p_category_modes);

  SELECT COALESCE(array_agg(vc.category_id), ARRAY[]::uuid[])
  INTO v_old_ids
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id;

  SELECT COALESCE(array_agg(old_id), ARRAY[]::uuid[])
  INTO v_removed
  FROM unnest(v_old_ids) AS old_id
  WHERE NOT (old_id = ANY (p_category_ids));

  SELECT COALESCE(array_agg(new_id), ARRAY[]::uuid[])
  INTO v_added
  FROM unnest(p_category_ids) AS new_id
  WHERE NOT (new_id = ANY (v_old_ids));

  SELECT
    v.shop_name,
    COALESCE(v.serves_at_vendor_place, false),
    COALESCE(v.serves_at_customer_place, true),
    v.service_radius_km
  INTO v_shop_name, v_acct_vendor_place, v_acct_customer_place, v_acct_radius
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  v_acct_brand := NULLIF(trim(COALESCE(v_shop_name, '')), '');
  v_needs_review := v_cat_count >= 3;

  FOR i IN 1..v_cat_count LOOP
    v_brand := CASE
      WHEN p_brand_names IS NOT NULL THEN NULLIF(trim(p_brand_names[i]), '')
      ELSE NULL
    END;
    v_vendor_place := CASE
      WHEN p_serves_at_vendor_place IS NOT NULL THEN p_serves_at_vendor_place[i]
      ELSE NULL
    END;
    v_customer_place := CASE
      WHEN p_serves_at_customer_place IS NOT NULL THEN p_serves_at_customer_place[i]
      ELSE NULL
    END;
    v_radius := CASE
      WHEN p_service_radius_km IS NOT NULL THEN p_service_radius_km[i]
      ELSE NULL
    END;

    v_brand := COALESCE(v_brand, v_acct_brand);
    v_vendor_place := COALESCE(v_vendor_place, v_acct_vendor_place);
    v_customer_place := COALESCE(v_customer_place, v_acct_customer_place);
    v_radius := COALESCE(v_radius, v_acct_radius);

    IF NOT COALESCE(v_vendor_place, false) AND NOT COALESCE(v_customer_place, false) THEN
      RAISE EXCEPTION 'category_reach_required';
    END IF;

    SELECT c.service_mode INTO v_catalog_mode
    FROM public.categories c
    WHERE c.id = p_category_ids[i];

    v_modes := public._modes_from_category_map(p_category_ids[i], p_category_modes);
    v_cat_primary := public._pick_primary_availability_mode(
      v_modes,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), v_catalog_mode)
    );

    SELECT vc.id
    INTO v_vc_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_ids[i]
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.vendor_categories
      SET
        is_primary = (i = 1),
        needs_review = v_needs_review,
        brand_name = v_brand,
        serves_at_vendor_place = v_vendor_place,
        serves_at_customer_place = v_customer_place,
        service_radius_km = v_radius
      WHERE id = v_vc_id;
    ELSE
      INSERT INTO public.vendor_categories (
        vendor_id,
        category_id,
        is_primary,
        status,
        needs_review,
        service_mode,
        brand_name,
        serves_at_vendor_place,
        serves_at_customer_place,
        service_radius_km
      )
      VALUES (
        p_vendor_id,
        p_category_ids[i],
        i = 1,
        'approved',
        v_needs_review,
        v_cat_primary,
        v_brand,
        v_vendor_place,
        v_customer_place,
        v_radius
      )
      RETURNING id INTO v_vc_id;
    END IF;

    PERFORM public._rewrite_vendor_category_modes(v_vc_id, v_modes, v_catalog_mode);
  END LOOP;

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id
    AND NOT (category_id = ANY (p_category_ids));

  IF COALESCE(array_length(v_removed, 1), 0) > 0 THEN
    PERFORM public._purge_saved_vendors_for_removed_categories(
      p_vendor_id,
      v_removed,
      v_shop_name
    );

    DELETE FROM public.vendor_category_cancel_reasons
    WHERE vendor_id = p_vendor_id
      AND category_id = ANY (v_removed);
  END IF;

  IF COALESCE(array_length(v_added, 1), 0) > 0 THEN
    FOREACH v_new_id IN ARRAY v_added
    LOOP
      PERFORM public._copy_account_cancel_reasons_to_category(p_vendor_id, v_new_id);
    END LOOP;
  END IF;

  PERFORM public._derive_vendor_availability_modes(p_vendor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
) TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
) IS
  'Reconcile vendor categories in place (preserves row IDs and photo/verification fields). Requires per-category mode map.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 7. vendor_sync_category_modes â€” accept jsonb map, never flatten
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

CREATE OR REPLACE FUNCTION public.vendor_sync_category_modes(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_modes jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vc record;
  v_modes text[];
  v_catalog_mode text;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors
    WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_category_modes IS NULL OR jsonb_typeof(p_category_modes) <> 'object' THEN
    RAISE EXCEPTION 'category_modes_required';
  END IF;

  FOR v_vc IN
    SELECT vc.id, vc.category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND p_category_modes ? vc.category_id::text
  LOOP
    SELECT c.service_mode INTO v_catalog_mode
    FROM public.categories c
    WHERE c.id = v_vc.category_id;

    v_modes := public._modes_from_category_map(v_vc.category_id, p_category_modes);

    IF COALESCE(array_length(v_modes, 1), 0) = 0 THEN
      RAISE EXCEPTION 'category_modes_empty: %', v_vc.category_id;
    END IF;

    PERFORM public._rewrite_vendor_category_modes(v_vc.id, v_modes, v_catalog_mode);
  END LOOP;

  PERFORM public._derive_vendor_availability_modes(p_vendor_id);
END;
$$;

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
  v_scalar text;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors
    WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  -- Legacy text[] callers: repair only â€” ensure each category scalar is in its child set.
  -- Never flatten multi-mode sets from p_modes.
  FOR v_vc IN
    SELECT vc.id, vc.service_mode
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
  LOOP
    v_scalar := lower(trim(COALESCE(v_vc.service_mode, 'help')));
    IF v_scalar NOT IN ('help', 'delivery', 'appointment') THEN
      v_scalar := 'help';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.vendor_category_modes vcm
      WHERE vcm.vendor_category_id = v_vc.id
        AND vcm.mode = v_scalar
    ) THEN
      INSERT INTO public.vendor_category_modes (vendor_category_id, mode)
      VALUES (v_vc.id, v_scalar)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  PERFORM public._derive_vendor_availability_modes(p_vendor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_sync_category_modes(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vendor_sync_category_modes(uuid, text, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.vendor_sync_category_modes(uuid, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_sync_category_modes(uuid, text, text[]) TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_sync_category_modes(uuid, text, jsonb) IS
  'Reconcile per-category availability modes from a jsonb map (categories not in map are untouched).';

COMMENT ON FUNCTION public.vendor_sync_category_modes(uuid, text, text[]) IS
  'Legacy repair path: ensures each category scalar mode is present in its child set; does not flatten from p_modes.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 8. vendor_update_availability_modes â€” deprecate independent writes
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    SELECT 1
    FROM public.vendors
    WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_modes IS NOT NULL THEN
    FOREACH v_mode IN ARRAY p_modes LOOP
      IF lower(trim(v_mode)) NOT IN ('help', 'delivery', 'appointment') THEN
        RAISE EXCEPTION 'invalid_availability_mode: %', v_mode;
      END IF;
    END LOOP;
  END IF;

  -- Account modes are derived from per-category child sets; p_modes is ignored for writes.
  PERFORM public._derive_vendor_availability_modes(p_vendor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_availability_modes(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_availability_modes(uuid, text, text[]) TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_update_availability_modes(uuid, text, text[]) IS
  'Deprecated direct account-mode writes. Validates caller identity; account availability is derived from categories.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 9. attach_pending_category â€” accept modes
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

DROP FUNCTION IF EXISTS public.attach_pending_category(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.attach_pending_category(
  p_vendor_id uuid,
  p_category_id uuid,
  p_service_mode text,
  p_modes text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vc_id uuid;
  v_modes text[];
  v_catalog_mode text;
  v_primary text;
BEGIN
  v_modes := public._normalize_availability_modes(
    COALESCE(p_modes, ARRAY[lower(trim(p_service_mode))])
  );

  IF COALESCE(array_length(v_modes, 1), 0) = 0 THEN
    RAISE EXCEPTION 'availability_modes_required';
  END IF;

  SELECT c.service_mode INTO v_catalog_mode
  FROM public.categories c
  WHERE c.id = p_category_id;

  v_primary := public._pick_primary_availability_mode(
    v_modes,
    COALESCE(NULLIF(trim(p_service_mode), ''), v_catalog_mode)
  );

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id;

  INSERT INTO public.vendor_categories (
    vendor_id,
    category_id,
    is_primary,
    status,
    needs_review,
    service_mode
  )
  VALUES (
    p_vendor_id,
    p_category_id,
    true,
    'approved',
    false,
    v_primary
  )
  RETURNING id INTO v_vc_id;

  PERFORM public._rewrite_vendor_category_modes(v_vc_id, v_modes, v_catalog_mode);
  PERFORM public._derive_vendor_availability_modes(p_vendor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.attach_pending_category(uuid, uuid, text, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.attach_pending_category(uuid, uuid, text, text[])
  TO anon, authenticated;

COMMENT ON FUNCTION public.attach_pending_category(uuid, uuid, text, text[]) IS
  'Replaces all vendor_categories with one pending/new category row and per-category modes.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 10. get_radar_category_mode_matches
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

CREATE OR REPLACE FUNCTION public.get_radar_category_mode_matches(
  p_mode text,
  p_category_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (vendor_id uuid, category_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT vc.vendor_id, vc.category_id
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.status = 'approved'
    AND vcm.mode = lower(trim(p_mode))
    AND (
      p_category_ids IS NULL
      OR cardinality(p_category_ids) = 0
      OR vc.category_id = ANY (p_category_ids)
    );
$$;

REVOKE ALL ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_radar_category_mode_matches(text, uuid[])
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) IS
  'Radar discovery: approved vendor/category pairs offering the given availability mode.';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 11. create_customer_request â€” add p_service_mode
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

DROP FUNCTION IF EXISTS public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid
);

CREATE OR REPLACE FUNCTION public.create_customer_request(
  p_device_id text,
  p_vendor_id uuid,
  p_message text,
  p_user_phone text DEFAULT NULL,
  p_device_id_log text DEFAULT NULL,
  p_delivery_address text DEFAULT NULL,
  p_delivery_slot text DEFAULT NULL,
  p_delivery_slot_deadline timestamptz DEFAULT NULL,
  p_appointment_time timestamptz DEFAULT NULL,
  p_appointment_status text DEFAULT NULL,
  p_customer_latitude double precision DEFAULT NULL,
  p_customer_longitude double precision DEFAULT NULL,
  p_appointment_instant boolean DEFAULT false,
  p_category_id uuid DEFAULT NULL,
  p_service_mode text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_active boolean;
  v_category_id uuid;
  v_service_mode text;
  v_category_scalar text;
  v_vendor_scalar text;
  v_category_modes text[];
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT v.is_active
  INTO v_vendor_active
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF lower(btrim(coalesce(p_delivery_slot, ''))) = 'asap' AND v_vendor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'vendor_not_live_for_asap';
  END IF;

  IF p_appointment_instant IS TRUE AND v_vendor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'vendor_not_live_for_instant';
  END IF;

  IF p_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
      AND vc.status = 'approved'
  ) THEN
    v_category_id := p_category_id;
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      SELECT c.id
      INTO v_category_id
      FROM public.vendors v
      JOIN public.categories c ON c.label = v.category
      WHERE v.id = p_vendor_id
      LIMIT 1;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(vcm.mode), ARRAY[]::text[])
  INTO v_category_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = v_category_id;

  IF p_service_mode IS NOT NULL AND trim(p_service_mode) <> '' THEN
    v_service_mode := lower(trim(p_service_mode));
    IF v_service_mode NOT IN ('help', 'delivery', 'appointment') THEN
      RAISE EXCEPTION 'invalid_service_mode';
    END IF;

    IF COALESCE(array_length(v_category_modes, 1), 0) > 0
       AND NOT (v_service_mode = ANY (v_category_modes))
    THEN
      RAISE EXCEPTION 'service_mode_not_available_for_category';
    END IF;
  ELSE
    IF COALESCE(array_length(v_category_modes, 1), 0) > 0 THEN
      IF p_delivery_slot IS NOT NULL AND 'delivery' = ANY (v_category_modes) THEN
        v_service_mode := 'delivery';
      ELSIF p_appointment_time IS NOT NULL AND 'appointment' = ANY (v_category_modes) THEN
        v_service_mode := 'appointment';
      ELSE
        SELECT vc.service_mode
        INTO v_category_scalar
        FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id
          AND vc.category_id = v_category_id
        LIMIT 1;

        v_service_mode := COALESCE(v_category_scalar, 'help');
      END IF;
    ELSE
      SELECT vc.service_mode
      INTO v_category_scalar
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.category_id = v_category_id
      LIMIT 1;

      SELECT v.service_mode
      INTO v_vendor_scalar
      FROM public.vendors v
      WHERE v.id = p_vendor_id;

      v_service_mode := COALESCE(
        v_category_scalar,
        v_vendor_scalar,
        CASE
          WHEN p_delivery_slot IS NOT NULL THEN 'delivery'
          WHEN p_appointment_time IS NOT NULL THEN 'appointment'
          ELSE 'help'
        END
      );
    END IF;
  END IF;

  INSERT INTO public.requests (
    device_id,
    vendor_id,
    message,
    status,
    user_phone,
    device_id_log,
    delivery_address,
    delivery_slot,
    delivery_slot_deadline,
    appointment_time,
    appointment_status,
    customer_latitude,
    customer_longitude,
    category_id,
    service_mode
  )
  VALUES (
    p_device_id,
    p_vendor_id,
    p_message,
    'sent',
    p_user_phone,
    p_device_id_log,
    p_delivery_address,
    p_delivery_slot,
    p_delivery_slot_deadline,
    p_appointment_time,
    p_appointment_status,
    p_customer_latitude,
    p_customer_longitude,
    v_category_id,
    v_service_mode
  )
  RETURNING id INTO v_id;

  IF v_vendor_active IS NOT TRUE
    AND p_user_phone IS NOT NULL
    AND btrim(p_user_phone) <> ''
  THEN
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route,
      route_params,
      related_id,
      is_informational,
      is_read
    )
    VALUES (
      p_user_phone,
      'order_update',
      (SELECT f.title FROM public.notification_i18n_format('vendor_offline_pending', p_user_phone) f),
      (SELECT f.body FROM public.notification_i18n_format('vendor_offline_pending', p_user_phone) f),
      'my-orders',
      jsonb_build_object('order_id', v_id),
      v_id,
      false,
      false
    );
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid, text
) TO anon, authenticated;

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid, text
) IS
  'Create customer request with immutable effective service_mode (validated against category modes when provided).';

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- 12. check_bill_before_fulfil â€” use request.service_mode
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

CREATE OR REPLACE FUNCTION public.check_bill_before_fulfil()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'fulfilled' AND OLD.status IS DISTINCT FROM 'fulfilled' THEN
    IF NEW.service_mode IN ('delivery', 'appointment') THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.order_bills WHERE request_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'cannot_fulfil_without_bill';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_bill_before_fulfil() IS
  'BEFORE UPDATE on requests: rejects fulfilment for delivery/appointment orders when no order_bills row exists.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Expose request.service_mode on order read RPCs
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_my_orders(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  device_id text,
  vendor_id uuid,
  message text,
  status text,
  payment_status text,
  created_at timestamptz,
  updated_at timestamptz,
  user_phone text,
  appointment_time timestamptz,
  appointment_status text,
  cancel_reason text,
  delivery_slot text,
  delivery_slot_deadline timestamptz,
  delivery_address text,
  customer_latitude double precision,
  customer_longitude double precision,
  is_edited boolean,
  vendor_shop_name text,
  vendor_service_mode text,
  vendor_phone text,
  vendor_latitude double precision,
  vendor_longitude double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_orders', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT
    r.id, r.device_id, r.vendor_id, r.message, r.status, r.payment_status,
    r.created_at, r.updated_at, r.user_phone, r.appointment_time,
    r.appointment_status, r.cancel_reason, r.delivery_slot,
    r.delivery_slot_deadline, r.delivery_address, r.customer_latitude,
    r.customer_longitude, r.is_edited,
    v.shop_name,
    COALESCE(r.service_mode, v.service_mode) AS vendor_service_mode,
    v.phone, v.latitude, v.longitude
  FROM public.requests r
  LEFT JOIN public.vendors v ON v.id = r.vendor_id
  WHERE r.status <> 'done'
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN r.user_phone = btrim(p_user_phone)
        ELSE r.device_id = btrim(p_device_id)
      END
    )
  ORDER BY r.created_at DESC;
END;
$$;

-- Adds service_mode to the return TABLE, changing the row type. CREATE OR REPLACE
-- cannot alter an existing function's return shape (42P13), so drop first, then
-- re-establish the same grants the recreated function needs.
DROP FUNCTION IF EXISTS public.get_vendor_incoming_orders(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.get_vendor_incoming_orders(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  device_id text,
  vendor_id uuid,
  message text,
  status text,
  created_at timestamptz,
  user_phone text,
  delivery_address text,
  delivery_slot text,
  appointment_time timestamptz,
  appointment_status text,
  cancel_reason text,
  is_edited boolean,
  payment_status text,
  payment_utr text,
  customer_latitude double precision,
  customer_longitude double precision,
  category_id uuid,
  category_label text,
  category_emoji text,
  service_mode text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_incoming_orders', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));

  RETURN QUERY
  SELECT
    r.id, r.device_id, r.vendor_id, r.message, r.status, r.created_at,
    r.user_phone, r.delivery_address, r.delivery_slot, r.appointment_time,
    r.appointment_status, r.cancel_reason, r.is_edited, r.payment_status,
    r.payment_utr, r.customer_latitude, r.customer_longitude, r.category_id,
    c.label, c.emoji, r.service_mode
  FROM public.requests r
  LEFT JOIN public.categories c ON c.id = r.category_id
  WHERE r.vendor_id = p_vendor_id
    AND (
      (r.status = 'sent' AND r.created_at >= now() - interval '48 hours')
      OR (r.status = 'seen' AND r.created_at >= now() - interval '24 hours')
      OR (r.status = 'accepted' AND r.created_at >= now() - interval '48 hours')
      OR (r.status = 'cancelled' AND r.created_at >= now() - interval '48 hours')
      OR r.status = 'fulfilled'
    )
  ORDER BY r.created_at DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_vendor_incoming_orders(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_incoming_orders(uuid, text, integer)
  TO anon, authenticated, service_role;
