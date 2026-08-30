-- UPI-hijack cluster (TEST first): SMS alert on actual UPI payee change,
-- rate-limit UPI-mutating RPCs (5/day per vendor_id), and require
-- p_vendor_phone on insert_bill_with_items via _assert_vendor_identity.
--
-- SMS is best-effort: a failed alert must not fail the vendor update.
-- Rate-limit runs after a real fingerprint change so GPS/active patches
-- are not counted. vendor_update_profile_and_categories wraps own+categories;
-- a transaction GUC sends one SMS and counts once.

SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value)
SELECT 'upi_alert_hook_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_config WHERE key = 'upi_alert_hook_secret'
);
RESET app.via_admin_rpc;

CREATE TABLE IF NOT EXISTS public.upi_change_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL,
  to_phone text NOT NULL,
  old_upi text,
  new_upi text,
  exotel_sid text,
  exotel_status text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upi_change_alerts_vendor_created
  ON public.upi_change_alerts (vendor_id, created_at DESC);

ALTER TABLE public.upi_change_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upi_change_alerts_service_role ON public.upi_change_alerts;
CREATE POLICY upi_change_alerts_service_role
  ON public.upi_change_alerts
  FOR ALL
  TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

GRANT ALL ON TABLE public.upi_change_alerts TO service_role;

CREATE OR REPLACE FUNCTION public._vendor_upi_fingerprint(p_vendor_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT md5(
    COALESCE((
      SELECT NULLIF(btrim(v.upi_id), '')
      FROM public.vendors v
      WHERE v.id = p_vendor_id
    ), '')
    || chr(1)
    || COALESCE((
      SELECT NULLIF(btrim(v.upi_qr_payee_id), '')
      FROM public.vendors v
      WHERE v.id = p_vendor_id
    ), '')
    || chr(1)
    || COALESCE((
      SELECT string_agg(
        vc.category_id::text
          || '='
          || COALESCE(NULLIF(btrim(vc.upi_id), ''), '')
          || '/'
          || COALESCE(NULLIF(btrim(vc.upi_qr_payee_id), ''), ''),
        ','
        ORDER BY vc.category_id
      )
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND (
          NULLIF(btrim(vc.upi_id), '') IS NOT NULL
          OR NULLIF(btrim(vc.upi_qr_payee_id), '') IS NOT NULL
        )
    ), '')
  );
$$;

COMMENT ON FUNCTION public._vendor_upi_fingerprint(uuid) IS
  'Stable fingerprint of account + per-category UPI payee fields. Used to detect actual UPI changes.';

CREATE OR REPLACE FUNCTION public._vendor_upi_display(p_vendor_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT NULLIF(btrim(v.upi_id), '')
      FROM public.vendors v
      WHERE v.id = p_vendor_id
    ),
    (
      SELECT NULLIF(btrim(v.upi_qr_payee_id), '')
      FROM public.vendors v
      WHERE v.id = p_vendor_id
    ),
    (
      SELECT COALESCE(NULLIF(btrim(vc.upi_id), ''), NULLIF(btrim(vc.upi_qr_payee_id), ''))
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND COALESCE(NULLIF(btrim(vc.upi_id), ''), NULLIF(btrim(vc.upi_qr_payee_id), '')) IS NOT NULL
      ORDER BY vc.category_id
      LIMIT 1
    ),
    '(cleared)'
  );
$$;

CREATE OR REPLACE FUNCTION public._finish_vendor_upi_mutation(
  p_vendor_id uuid,
  p_old_fp text,
  p_old_upi text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_fp text;
  v_phone text;
  v_new_upi text;
  v_url text;
  v_anon text;
  v_secret text;
BEGIN
  v_new_fp := public._vendor_upi_fingerprint(p_vendor_id);
  IF v_new_fp IS NOT DISTINCT FROM p_old_fp THEN
    RETURN;
  END IF;

  -- Wrapper RPC (profile_and_categories) calls own then categories in one
  -- transaction. Count + SMS once.
  IF current_setting('aaspaas.upi_mutate_done', true) = '1' THEN
    RETURN;
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'vendor_upi_mutate',
    'vendor_id',
    p_vendor_id::text,
    5,
    86400
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  PERFORM set_config('aaspaas.upi_mutate_done', '1', true);

  SELECT NULLIF(btrim(v.phone), '')
  INTO v_phone
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  v_new_upi := public._vendor_upi_display(p_vendor_id);

  IF v_phone IS NULL THEN
    RAISE WARNING 'upi_change_alert skipped: vendor % has no phone', p_vendor_id;
    RETURN;
  END IF;

  BEGIN
    SELECT value INTO v_url FROM public.app_config WHERE key = 'edge_function_url';
    SELECT value INTO v_anon FROM public.app_config WHERE key = 'anon_key';
    SELECT value INTO v_secret FROM public.app_config WHERE key = 'upi_alert_hook_secret';

    IF v_url IS NULL OR btrim(v_url) = ''
       OR v_anon IS NULL OR btrim(v_anon) = '' THEN
      RAISE WARNING 'upi_change_alert skipped: app_config edge_function_url/anon_key missing';
      RETURN;
    END IF;

    PERFORM net.http_post(
      url := btrim(v_url) || '/notify-upi-change',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || btrim(v_anon),
        'apikey', btrim(v_anon),
        'x-upi-alert-secret', COALESCE(v_secret, '')
      ),
      body := jsonb_build_object(
        'vendor_id', p_vendor_id,
        'old_upi', p_old_upi,
        'new_upi', v_new_upi
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'upi_change_alert http failed: %', SQLERRM;
  END;
END;
$$;

COMMENT ON FUNCTION public._finish_vendor_upi_mutation(uuid, text, text) IS
  'After a vendor UPI write: rate-limit 5/day per vendor_id and fire a best-effort SMS alert. Does not raise on SMS/http failure.';

REVOKE ALL ON FUNCTION public._vendor_upi_fingerprint(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._vendor_upi_display(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._finish_vendor_upi_mutation(uuid, text, text) FROM PUBLIC;


-- ── vendor_update_own: snapshot + finish ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_update_own(p_vendor_id uuid, p_vendor_phone text, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amber numeric;
  v_red numeric;
  v_upi_fp_before text;
  v_upi_before text;
BEGIN
  v_upi_fp_before := public._vendor_upi_fingerprint(p_vendor_id);
  SELECT NULLIF(btrim(upi_id), '') INTO v_upi_before FROM public.vendors WHERE id = p_vendor_id;

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
  PERFORM public._finish_vendor_upi_mutation(p_vendor_id, v_upi_fp_before, v_upi_before);
END;
$function$;

-- ── vendor_update_categories: snapshot + finish ──────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_update_categories(p_vendor_id uuid, p_vendor_phone text, p_category_ids uuid[], p_category_service_modes text[], p_category_modes jsonb, p_brand_names text[] DEFAULT NULL::text[], p_serves_at_vendor_place boolean[] DEFAULT NULL::boolean[], p_serves_at_customer_place boolean[] DEFAULT NULL::boolean[], p_service_radius_km numeric[] DEFAULT NULL::numeric[], p_delivery_fulfillment_methods text[] DEFAULT NULL::text[], p_delivery_payment_timings text[] DEFAULT NULL::text[], p_upi_id text DEFAULT NULL::text, p_upi_qr_url text DEFAULT NULL::text, p_upi_qr_payee_id text DEFAULT NULL::text, p_base_type text DEFAULT NULL::text, p_upi_ids text[] DEFAULT NULL::text[], p_upi_qr_urls text[] DEFAULT NULL::text[], p_upi_qr_payee_ids text[] DEFAULT NULL::text[], p_base_types text[] DEFAULT NULL::text[], p_latitudes double precision[] DEFAULT NULL::double precision[], p_longitudes double precision[] DEFAULT NULL::double precision[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_upi_before text;
BEGIN
  v_upi_fp_before := public._vendor_upi_fingerprint(p_vendor_id);
  SELECT NULLIF(btrim(upi_id), '') INTO v_upi_before FROM public.vendors WHERE id = p_vendor_id;

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

    SELECT vc.id, vc.latitude, vc.longitude
    INTO v_vc_id, v_old_lat, v_old_lng
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_ids[i]
    FOR UPDATE;

    IF FOUND THEN
      v_gps_changed := p_latitudes IS NOT NULL
        AND v_old_lat IS NOT NULL
        AND (
          v_old_lat IS DISTINCT FROM p_latitudes[i]
          OR v_old_lng IS DISTINCT FROM p_longitudes[i]
        );

      IF v_gps_changed THEN
        PERFORM set_config('app.via_system_rpc', 'true', true);
      END IF;

      UPDATE public.vendor_categories vc
      SET
        is_primary = (i = 1),
        needs_review = v_needs_review,
        brand_name = v_brand,
        serves_at_vendor_place = v_vendor_place,
        serves_at_customer_place = v_customer_place,
        service_radius_km = v_radius,
        delivery_fulfillment_method = v_delivery_fulfillment,
        delivery_payment_timing = v_delivery_payment,
        upi_id = CASE
          WHEN p_upi_ids IS NOT NULL THEN NULLIF(btrim(p_upi_ids[i]), '')
          ELSE vc.upi_id
        END,
        upi_qr_url = CASE
          WHEN p_upi_qr_urls IS NOT NULL THEN NULLIF(btrim(p_upi_qr_urls[i]), '')
          ELSE vc.upi_qr_url
        END,
        upi_qr_payee_id = CASE
          WHEN p_upi_qr_payee_ids IS NOT NULL THEN NULLIF(btrim(p_upi_qr_payee_ids[i]), '')
          ELSE vc.upi_qr_payee_id
        END,
        base_type = CASE
          WHEN p_base_types IS NOT NULL THEN v_row_base
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
        shop_photo_url = CASE WHEN v_gps_changed THEN NULL ELSE vc.shop_photo_url END,
        gps_match_distance = CASE WHEN v_gps_changed THEN NULL ELSE vc.gps_match_distance END,
        verification_status = CASE
          WHEN v_gps_changed THEN 'identity_linked'
          ELSE vc.verification_status
        END,
        is_manual_verified = CASE
          WHEN v_gps_changed THEN false
          ELSE vc.is_manual_verified
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
  PERFORM public._finish_vendor_upi_mutation(p_vendor_id, v_upi_fp_before, v_upi_before);
END;
$function$;

-- ── vendor_verify_upi: shared 5/day UPI-mutate bucket ────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_verify_upi(p_vendor_id uuid, p_vendor_phone text, p_upi_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_phone text;
  v_input text;
  v_saved text;
BEGIN
  v_phone := NULLIF(trim(p_vendor_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_input := NULLIF(trim(p_upi_id), '');
  IF v_input IS NULL THEN
    RAISE EXCEPTION 'upi_id_required';
  END IF;

  -- Same rule as src/lib/supabase.ts isValidUpi (handle@bank).
  -- PG POSIX quantifiers max out at 255, so length-check instead of {2,256}.
  IF (length(v_input) - length(replace(v_input, '@', ''))) <> 1
     OR v_input !~ '^[A-Za-z0-9_.\-]+@[A-Za-z]+$'
     OR char_length(split_part(v_input, '@', 1)) NOT BETWEEN 2 AND 256
     OR char_length(split_part(v_input, '@', 2)) NOT BETWEEN 2 AND 64
  THEN
    RAISE EXCEPTION 'invalid_upi_format';
  END IF;

  SELECT v.upi_id
  INTO v_saved
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.phone = v_phone
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'vendor_upi_mutate',
    'vendor_id',
    p_vendor_id::text,
    5,
    86400
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF NULLIF(trim(COALESCE(v_saved, '')), '') IS DISTINCT FROM v_input THEN
    RAISE EXCEPTION 'upi_id_mismatch';
  END IF;

  UPDATE public.vendors
  SET
    upi_verified = true,
    last_updated = now()
  WHERE id = p_vendor_id
    AND phone = v_phone;
END;
$function$;

-- ── insert_bill_with_items: require p_vendor_phone ───────────────────────────

DROP FUNCTION IF EXISTS public.insert_bill_with_items(uuid, uuid, text, numeric, text, text, text, jsonb, text, text);

CREATE OR REPLACE FUNCTION public.insert_bill_with_items(p_order_id uuid, p_vendor_id uuid, p_customer_phone text, p_total numeric, p_payment_mode text, p_payment_status text DEFAULT 'unpaid'::text, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_delivery_fulfillment_method text DEFAULT NULL::text, p_delivery_payment_timing text DEFAULT NULL::text, p_vendor_phone text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bill_id uuid;
  v_item jsonb;
  v_name text;
  v_qty numeric;
  v_unit_price numeric;
  v_unit text;
  v_phone text;
  v_void_bill record;
  v_outstanding numeric;
  v_khata_note text;
  v_red_limit numeric;
  v_fulfillment text;
  v_payment_timing text;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  v_phone := NULLIF(TRIM(p_customer_phone), '');

  IF p_delivery_fulfillment_method IS NOT NULL THEN
    v_fulfillment := NULLIF(btrim(p_delivery_fulfillment_method), '');
    IF v_fulfillment IS NOT NULL AND v_fulfillment NOT IN ('vendor', 'agent') THEN
      RAISE EXCEPTION 'invalid_delivery_fulfillment_method';
    END IF;
    v_payment_timing := NULLIF(btrim(COALESCE(p_delivery_payment_timing, '')), '');
    IF v_fulfillment = 'vendor' THEN
      v_payment_timing := 'postpaid';
    ELSIF v_payment_timing IS NULL THEN
      v_payment_timing := 'postpaid';
    ELSIF v_payment_timing NOT IN ('prepaid', 'postpaid') THEN
      RAISE EXCEPTION 'invalid_delivery_payment_timing';
    END IF;

    UPDATE public.requests r
    SET
      delivery_fulfillment_method = v_fulfillment,
      delivery_payment_timing = v_payment_timing
    WHERE r.id = p_order_id
      AND r.vendor_id = p_vendor_id
      AND r.service_mode = 'delivery'
      AND v_fulfillment IS NOT NULL;
  END IF;

  SELECT
    ob.id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode
  INTO v_void_bill
  FROM public.order_bills ob
  WHERE ob.request_id = p_order_id
    AND ob.payment_status = 'void'
  LIMIT 1;

  IF FOUND THEN
    IF v_void_bill.payment_mode = 'khata' AND v_void_bill.user_phone IS NOT NULL THEN
      INSERT INTO public.khata_transactions (
        vendor_id,
        user_phone,
        amount,
        note,
        payment_mode,
        request_id
      )
      VALUES (
        v_void_bill.vendor_id,
        v_void_bill.user_phone,
        -v_void_bill.total_amount,
        'Bill voided',
        'khata',
        p_order_id
      );

      SELECT kl.total_outstanding
      INTO v_outstanding
      FROM public.khata_ledger kl
      WHERE kl.vendor_id = v_void_bill.vendor_id
        AND kl.user_phone = v_void_bill.user_phone;

      IF FOUND THEN
        UPDATE public.khata_ledger
        SET
          total_outstanding = GREATEST(0, v_outstanding - v_void_bill.total_amount),
          last_updated = now()
        WHERE vendor_id = v_void_bill.vendor_id
          AND user_phone = v_void_bill.user_phone;
      END IF;
    END IF;

    DELETE FROM public.order_bills
    WHERE id = v_void_bill.id;
  END IF;

  INSERT INTO public.order_bills (
    request_id,
    vendor_id,
    user_phone,
    total_amount,
    payment_mode,
    payment_status,
    notes
  )
  VALUES (
    p_order_id,
    p_vendor_id,
    v_phone,
    p_total,
    p_payment_mode,
    p_payment_status,
    NULLIF(TRIM(p_notes), '')
  )
  RETURNING id INTO v_bill_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_name := v_item->>'name';
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price', '')::numeric, 0);
    v_unit := NULLIF(TRIM(COALESCE(v_item->>'unit', '')), '');

    IF v_name IS NOT NULL AND TRIM(v_name) <> '' AND v_unit_price > 0 THEN
      INSERT INTO public.order_items (
        request_id,
        description,
        quantity,
        unit,
        unit_price
      )
      VALUES (
        p_order_id,
        TRIM(v_name),
        GREATEST(v_qty, 1),
        v_unit,
        v_unit_price
      );
    END IF;
  END LOOP;

  IF p_payment_mode = 'khata' AND v_phone IS NOT NULL THEN
    SELECT v.khata_red_limit
    INTO v_red_limit
    FROM public.vendors v
    WHERE v.id = p_vendor_id;

    IF v_red_limit IS NOT NULL AND v_red_limit > 0 THEN
      INSERT INTO public.khata_ledger (
        vendor_id,
        user_phone,
        total_outstanding,
        last_updated
      )
      VALUES (
        p_vendor_id,
        v_phone,
        0,
        now()
      )
      ON CONFLICT (vendor_id, user_phone) DO NOTHING;

      SELECT kl.total_outstanding
      INTO v_outstanding
      FROM public.khata_ledger kl
      WHERE kl.vendor_id = p_vendor_id
        AND kl.user_phone = v_phone
      FOR UPDATE;

      IF COALESCE(v_outstanding, 0) >= v_red_limit THEN
        RAISE EXCEPTION 'khata_red_limit_exceeded';
      END IF;
    END IF;

    v_khata_note := COALESCE(NULLIF(TRIM(p_notes), ''), 'Bill from order');

    INSERT INTO public.khata_transactions (
      vendor_id,
      user_phone,
      amount,
      note,
      payment_mode,
      request_id
    )
    VALUES (
      p_vendor_id,
      v_phone,
      p_total,
      v_khata_note,
      'khata',
      p_order_id
    );

    INSERT INTO public.khata_ledger (
      vendor_id,
      user_phone,
      total_outstanding,
      last_updated
    )
    VALUES (
      p_vendor_id,
      v_phone,
      p_total,
      now()
    )
    ON CONFLICT (vendor_id, user_phone)
    DO UPDATE SET
      total_outstanding = public.khata_ledger.total_outstanding + EXCLUDED.total_outstanding,
      last_updated = now();
  END IF;

  PERFORM public._stamp_request_upi_payee(p_order_id, 'intended');

  RETURN v_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_bill_with_items(
  uuid, uuid, text, numeric, text, text, text, jsonb, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.insert_bill_with_items(
  uuid, uuid, text, numeric, text, text, text, jsonb, text, text, text
) TO anon, authenticated;
