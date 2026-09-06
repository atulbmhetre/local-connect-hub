-- 1) Notify vendor when admin rejects a 6th+ business (reason in body).
-- 2) Allow fresh Add Business for a previously rejected category (reset row).
-- 3) Allocate unique vendor referral_code on register_vendor (AASP+last4 + suffix on collision).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

-- ── Referral code allocation ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._allocate_vendor_referral_code(p_phone text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digits text;
  v_base text;
  v_code text;
  v_n integer := 0;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) = 12 AND v_digits LIKE '91%' THEN
    v_digits := right(v_digits, 10);
  ELSIF length(v_digits) = 11 AND v_digits LIKE '1%' THEN
    v_digits := right(v_digits, 10);
  END IF;

  IF length(v_digits) < 4 THEN
    RAISE EXCEPTION 'invalid_phone_for_referral_code' USING ERRCODE = 'P0001';
  END IF;

  v_base := 'AASP' || right(v_digits, 4);
  v_code := v_base;

  WHILE EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE upper(btrim(v.referral_code)) = v_code
      AND regexp_replace(COALESCE(v.phone, ''), '\D', '', 'g') IS DISTINCT FROM v_digits
  ) LOOP
    v_n := v_n + 1;
    IF v_n > 99 THEN
      RAISE EXCEPTION 'referral_code_exhausted' USING ERRCODE = 'P0001';
    END IF;
    v_code := v_base || v_n::text;
  END LOOP;

  RETURN v_code;
END;
$$;

COMMENT ON FUNCTION public._allocate_vendor_referral_code(text) IS
  'Vendor referral_code: AASP + last 4 phone digits; on collision append 1..99 until unique.';

REVOKE ALL ON FUNCTION public._allocate_vendor_referral_code(text) FROM PUBLIC;

-- Patch register_vendor to use server-side allocation (preserves hybrid-session inject).
DO $patch_referral$
DECLARE
  r record;
  def text;
BEGIN
  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'register_vendor'
    ORDER BY p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('public._allocate_vendor_referral_code' IN def) > 0 THEN
      CONTINUE;
    END IF;
    IF position('upper(trim(p_referral_code))' IN def) = 0 THEN
      RAISE EXCEPTION 'register_vendor referral_code insert pattern not found (oid %)', r.oid;
    END IF;
    def := replace(
      def,
      'upper(trim(p_referral_code))',
      'public._allocate_vendor_referral_code(trim(p_phone))'
    );
    EXECUTE def;
  END LOOP;
END;
$patch_referral$;

-- ── Reject notification i18n ─────────────────────────────────────────────────

INSERT INTO public.notification_i18n (copy_key, lang, title, body)
VALUES
  ('vendor_business_rejected', 'en', 'Business not approved', '{reason}'),
  ('vendor_business_rejected', 'hi', 'व्यवसाय स्वीकृत नहीं', '{reason}'),
  ('vendor_business_rejected', 'mr', 'व्यवसाय मंजूर नाही', '{reason}')
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

-- ── admin_reject_vendor_business: notify vendor with reason ──────────────────

CREATE OR REPLACE FUNCTION public.admin_reject_vendor_business(
  p_admin_phone text,
  p_vendor_category_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_phone text;
  v_reason text;
  v_title text;
  v_body text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  v_reason := NULLIF(left(btrim(COALESCE(p_reason, '')), 280), '');

  UPDATE public.vendor_categories
  SET
    status = 'rejected',
    needs_review = false,
    review_reason = v_reason
  WHERE id = p_vendor_category_id
    AND status = 'pending_review'
  RETURNING vendor_id INTO v_vendor_id;

  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'vendor_business_not_pending';
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone
  FROM public.vendors
  WHERE id = v_vendor_id;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    'vendor_business_rejected',
    COALESCE(v_phone, 'en'),
    jsonb_build_object(
      'reason',
      COALESCE(v_reason, 'Your business was not approved at this time.')
    )
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    v_vendor_id,
    v_title,
    v_body,
    'vendor_business_rejected',
    'settings',
    jsonb_build_object(
      'vendor_id', v_vendor_id,
      'vendor_category_id', p_vendor_category_id
    ),
    NULL,
    NULL,
    NULL,
    true
  );
END;
$$;

COMMENT ON FUNCTION public.admin_reject_vendor_business(text, uuid, text) IS
  'Admin session: reject a 6th+ business; notifies vendor with the rejection reason.';

-- ── vendor_update_categories: fresh Add Business over rejected row ───────────

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[],
  p_category_modes jsonb,
  p_brand_names text[] DEFAULT NULL::text[],
  p_serves_at_vendor_place boolean[] DEFAULT NULL::boolean[],
  p_serves_at_customer_place boolean[] DEFAULT NULL::boolean[],
  p_service_radius_km numeric[] DEFAULT NULL::numeric[],
  p_delivery_fulfillment_methods text[] DEFAULT NULL::text[],
  p_delivery_payment_timings text[] DEFAULT NULL::text[],
  p_upi_id text DEFAULT NULL::text,
  p_upi_qr_url text DEFAULT NULL::text,
  p_upi_qr_payee_id text DEFAULT NULL::text,
  p_base_type text DEFAULT NULL::text,
  p_upi_ids text[] DEFAULT NULL::text[],
  p_upi_qr_urls text[] DEFAULT NULL::text[],
  p_upi_qr_payee_ids text[] DEFAULT NULL::text[],
  p_base_types text[] DEFAULT NULL::text[],
  p_latitudes double precision[] DEFAULT NULL::double precision[],
  p_longitudes double precision[] DEFAULT NULL::double precision[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
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
  v_delivery_fulfillment text;
  v_delivery_payment text;
  v_base_type text;
  v_row_base text;
  v_old_lat double precision;
  v_old_lng double precision;
  v_gps_changed boolean;
  v_upi_fp_before text;
  v_old_status text;
  v_approved_count integer;
  v_reactivating_rejected boolean;
BEGIN
  v_upi_fp_before := public._vendor_upi_fingerprint(p_vendor_id);

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

  v_base_type := NULL;
  IF p_base_type IS NOT NULL AND btrim(p_base_type) <> '' THEN
    v_base_type := lower(btrim(p_base_type));
    IF v_base_type = 'visiting' THEN
      v_base_type := 'none';
    END IF;
    IF v_base_type NOT IN ('shop', 'home', 'none') THEN
      RAISE EXCEPTION 'base_type_required: must be shop, home, or none' USING ERRCODE = 'P0001';
    END IF;
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
  IF p_delivery_fulfillment_methods IS NOT NULL
    AND COALESCE(array_length(p_delivery_fulfillment_methods, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'delivery_fulfillment_methods length must match category_ids length';
  END IF;
  IF p_delivery_payment_timings IS NOT NULL
    AND COALESCE(array_length(p_delivery_payment_timings, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'delivery_payment_timings length must match category_ids length';
  END IF;
  IF p_upi_ids IS NOT NULL
    AND COALESCE(array_length(p_upi_ids, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'upi_ids length must match category_ids length';
  END IF;
  IF p_upi_qr_urls IS NOT NULL
    AND COALESCE(array_length(p_upi_qr_urls, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'upi_qr_urls length must match category_ids length';
  END IF;
  IF p_upi_qr_payee_ids IS NOT NULL
    AND COALESCE(array_length(p_upi_qr_payee_ids, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'upi_qr_payee_ids length must match category_ids length';
  END IF;
  IF p_base_types IS NOT NULL
    AND COALESCE(array_length(p_base_types, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'base_types length must match category_ids length';
  END IF;
  IF (p_latitudes IS NULL) <> (p_longitudes IS NULL) THEN
    RAISE EXCEPTION 'latitudes and longitudes must be provided together';
  END IF;
  IF p_latitudes IS NOT NULL
    AND COALESCE(array_length(p_latitudes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'latitudes length must match category_ids length';
  END IF;
  IF p_longitudes IS NOT NULL
    AND COALESCE(array_length(p_longitudes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'longitudes length must match category_ids length';
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
    v_delivery_fulfillment := CASE
      WHEN p_delivery_fulfillment_methods IS NOT NULL THEN NULLIF(trim(p_delivery_fulfillment_methods[i]), '')
      ELSE NULL
    END;
    v_delivery_payment := CASE
      WHEN p_delivery_payment_timings IS NOT NULL THEN NULLIF(trim(p_delivery_payment_timings[i]), '')
      ELSE NULL
    END;

    v_brand := COALESCE(v_brand, v_acct_brand);
    v_vendor_place := COALESCE(v_vendor_place, v_acct_vendor_place);
    v_customer_place := COALESCE(v_customer_place, v_acct_customer_place);
    v_radius := COALESCE(v_radius, v_acct_radius);
    v_delivery_fulfillment := COALESCE(v_delivery_fulfillment, 'vendor');
    v_delivery_payment := COALESCE(v_delivery_payment, 'postpaid');

    IF v_delivery_fulfillment NOT IN ('vendor', 'agent') THEN
      RAISE EXCEPTION 'invalid_delivery_fulfillment_method';
    END IF;
    IF v_delivery_payment NOT IN ('prepaid', 'postpaid') THEN
      RAISE EXCEPTION 'invalid_delivery_payment_timing';
    END IF;
    IF v_delivery_fulfillment = 'vendor' THEN
      v_delivery_payment := 'postpaid';
    END IF;

    IF NOT COALESCE(v_vendor_place, false) AND NOT COALESCE(v_customer_place, false) THEN
      RAISE EXCEPTION 'category_reach_required';
    END IF;

    v_row_base := NULL;
    IF p_base_types IS NOT NULL THEN
      v_row_base := lower(btrim(COALESCE(p_base_types[i], '')));
      IF v_row_base = 'visiting' THEN
        v_row_base := 'none';
      END IF;
      IF v_row_base = '' THEN
        v_row_base := NULL;
      ELSIF v_row_base NOT IN ('shop', 'home', 'none') THEN
        RAISE EXCEPTION 'base_type_required: must be shop, home, or none' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    SELECT c.service_mode INTO v_catalog_mode
    FROM public.categories c
    WHERE c.id = p_category_ids[i];

    v_modes := public._modes_from_category_map(p_category_ids[i], p_category_modes);
    v_cat_primary := public._pick_primary_availability_mode(
      v_modes,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), v_catalog_mode)
    );

    SELECT vc.id, vc.latitude, vc.longitude, vc.status
    INTO v_vc_id, v_old_lat, v_old_lng, v_old_status
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_ids[i]
    FOR UPDATE;

    IF FOUND THEN
      v_reactivating_rejected := COALESCE(v_old_status, '') = 'rejected';

      IF v_reactivating_rejected THEN
        SELECT count(*)::integer
        INTO v_approved_count
        FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id
          AND vc.status = 'approved';
      END IF;

      v_gps_changed := p_latitudes IS NOT NULL
        AND v_old_lat IS NOT NULL
        AND (
          v_old_lat IS DISTINCT FROM p_latitudes[i]
          OR v_old_lng IS DISTINCT FROM p_longitudes[i]
        );

      IF v_gps_changed OR v_reactivating_rejected THEN
        PERFORM set_config('app.via_system_rpc', 'true', true);
      END IF;

      UPDATE public.vendor_categories vc
      SET
        is_primary = (i = 1),
        status = CASE
          WHEN v_reactivating_rejected AND v_approved_count >= 5 THEN 'pending_review'
          WHEN v_reactivating_rejected THEN 'approved'
          ELSE vc.status
        END,
        needs_review = CASE
          WHEN v_reactivating_rejected AND v_approved_count >= 5 THEN true
          WHEN v_reactivating_rejected THEN v_needs_review
          ELSE v_needs_review
        END,
        review_reason = CASE
          WHEN v_reactivating_rejected THEN NULL
          ELSE vc.review_reason
        END,
        brand_name = v_brand,
        serves_at_vendor_place = v_vendor_place,
        serves_at_customer_place = v_customer_place,
        service_radius_km = v_radius,
        delivery_fulfillment_method = v_delivery_fulfillment,
        delivery_payment_timing = v_delivery_payment,
        upi_id = CASE
          WHEN p_upi_ids IS NOT NULL THEN NULLIF(btrim(p_upi_ids[i]), '')
          WHEN v_reactivating_rejected AND p_upi_id IS NOT NULL THEN NULLIF(btrim(p_upi_id), '')
          ELSE vc.upi_id
        END,
        upi_qr_url = CASE
          WHEN p_upi_qr_urls IS NOT NULL THEN NULLIF(btrim(p_upi_qr_urls[i]), '')
          WHEN v_reactivating_rejected THEN NULL
          ELSE vc.upi_qr_url
        END,
        upi_qr_payee_id = CASE
          WHEN p_upi_qr_payee_ids IS NOT NULL THEN NULLIF(btrim(p_upi_qr_payee_ids[i]), '')
          WHEN v_reactivating_rejected THEN NULL
          ELSE vc.upi_qr_payee_id
        END,
        base_type = CASE
          WHEN p_base_types IS NOT NULL THEN v_row_base
          WHEN v_reactivating_rejected AND p_base_type IS NOT NULL THEN v_base_type
          ELSE vc.base_type
        END,
        latitude = CASE
          WHEN p_latitudes IS NOT NULL THEN p_latitudes[i]
          ELSE vc.latitude
        END,
        longitude = CASE
          WHEN p_longitudes IS NOT NULL THEN p_longitudes[i]
          ELSE vc.longitude
        END,
        shop_photo_url = CASE
          WHEN v_reactivating_rejected THEN NULL
          WHEN v_gps_changed THEN NULL
          ELSE vc.shop_photo_url
        END,
        gps_match_distance = CASE
          WHEN v_reactivating_rejected THEN NULL
          WHEN v_gps_changed THEN NULL
          ELSE vc.gps_match_distance
        END,
        verification_status = CASE
          WHEN v_reactivating_rejected THEN 'identity_linked'
          WHEN v_gps_changed THEN 'identity_linked'
          ELSE vc.verification_status
        END,
        is_manual_verified = CASE
          WHEN v_reactivating_rejected THEN false
          WHEN v_gps_changed THEN false
          ELSE vc.is_manual_verified
        END,
        is_paused = CASE
          WHEN v_reactivating_rejected THEN false
          ELSE vc.is_paused
        END
      WHERE vc.id = v_vc_id;
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
        service_radius_km,
        delivery_fulfillment_method,
        delivery_payment_timing,
        upi_id,
        upi_qr_url,
        upi_qr_payee_id,
        base_type,
        latitude,
        longitude
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
        v_radius,
        v_delivery_fulfillment,
        v_delivery_payment,
        COALESCE(
          CASE WHEN p_upi_ids IS NOT NULL THEN NULLIF(btrim(p_upi_ids[i]), '') END,
          NULLIF(trim(p_upi_id), '')
        ),
        COALESCE(
          CASE WHEN p_upi_qr_urls IS NOT NULL THEN NULLIF(btrim(p_upi_qr_urls[i]), '') END,
          NULLIF(trim(p_upi_qr_url), '')
        ),
        COALESCE(
          CASE WHEN p_upi_qr_payee_ids IS NOT NULL THEN NULLIF(btrim(p_upi_qr_payee_ids[i]), '') END,
          NULLIF(trim(p_upi_qr_payee_id), '')
        ),
        COALESCE(v_row_base, v_base_type),
        CASE WHEN p_latitudes IS NOT NULL THEN p_latitudes[i] ELSE NULL END,
        CASE WHEN p_longitudes IS NOT NULL THEN p_longitudes[i] ELSE NULL END
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
  PERFORM public._rate_limit_vendor_upi_if_changed(p_vendor_id, v_upi_fp_before);
END;
$function$;

COMMENT ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[],
  text[], text[], text, text, text, text, text[], text[], text[], text[],
  double precision[], double precision[]
) IS
  'Reconcile vendor categories. Re-adding a rejected category resets it as a fresh business.';
