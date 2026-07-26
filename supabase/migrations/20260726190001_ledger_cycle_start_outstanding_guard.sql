-- Block vendor_update_own ledger_cycle_start changes while any customer
-- khata_ledger row for that vendor has total_outstanding > 0.
-- Same outstanding existence check as get_vendor_khata_has_outstanding
-- (disable-khata guard). Credit-limit patches are intentionally not gated.

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

  -- Defense in depth: keep category brand_name in sync with shop_name.
  IF p_patch ? 'shop_name' THEN
    UPDATE public.vendor_categories vc
    SET brand_name = NULLIF(trim(p_patch->>'shop_name'), '')
    WHERE vc.vendor_id = p_vendor_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_update_own(uuid, text, jsonb) IS
  'Vendor self-update. Blocks discoverable/upi_verified/verification_status/subscription fields. Ban + required-photos assert on is_active=true. Enforces khata_red_limit=0 OR (red>amber AND amber>=0). Blocks ledger_cycle_start while any khata_ledger.total_outstanding > 0. shop_name patch syncs vendor_categories.brand_name.';

REVOKE ALL ON FUNCTION public.vendor_update_own(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_own(uuid, text, jsonb) TO anon, authenticated, service_role;
