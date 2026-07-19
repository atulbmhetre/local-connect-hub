-- Vendor Profile & Lifecycle hardening:
-- 1) Restore _assert_vendor_not_banned in vendor_update_own (lost in 20260719100001)
-- 2) Ban assert on appointment-path vendor mutations
-- 4+8) create_customer_request: vendor ban/discoverable + customer ban
-- 5) Phone ownership on attach_pending_category / promote_green_pending*
-- 6) Ban-aware feed (vendor_post_offer + get_local_feed_posts)
-- 9) Atomic vendor_update_profile_and_categories
-- 13) Sync vendor_categories.brand_name from vendors.shop_name (single source of truth)
-- + service_role A/B helpers for ban-assert regression proof

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. One-time backfill: category brand_name ← account shop_name
-- (brand_name lives on vendor_categories, NOT vendors — see 20260711200001)
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.vendor_categories vc
SET brand_name = NULLIF(trim(v.shop_name), '')
FROM public.vendors v
WHERE vc.vendor_id = v.id
  AND NULLIF(trim(COALESCE(vc.brand_name, '')), '')
    IS DISTINCT FROM NULLIF(trim(COALESCE(v.shop_name, '')), '');

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 + 13. vendor_update_own: ban assert on go-live + sync brand_name on shop_name
-- ═══════════════════════════════════════════════════════════════════════════

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
  IF p_patch ? 'is_active' AND (p_patch->>'is_active')::boolean IS TRUE THEN
    PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);
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
  'Vendor self-update. Blocks discoverable/upi_verified/verification_status/subscription fields. Ban assert on is_active=true. shop_name patch syncs vendor_categories.brand_name.';

REVOKE ALL ON FUNCTION public.vendor_update_own(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_own(uuid, text, jsonb) TO anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- A/B helpers (service_role only) — strip/restore ban assert for regression proof
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._test_set_vendor_update_own_ban_assert(p_enabled boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  def text;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p
  WHERE p.proname = 'vendor_update_own'
    AND p.pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'vendor_update_own missing';
  END IF;

  IF p_enabled THEN
    IF position('_assert_vendor_not_banned' IN def) > 0 THEN
      RETURN 'already_enabled';
    END IF;
    def := replace(
      def,
      E'BEGIN\n  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN',
      E'BEGIN\n  IF p_patch ? ''is_active'' AND (p_patch->>''is_active'')::boolean IS TRUE THEN\n    PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);\n  END IF;\n\n  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN'
    );
    IF position('_assert_vendor_not_banned' IN def) = 0 THEN
      RAISE EXCEPTION 'failed to inject ban gate into vendor_update_own';
    END IF;
    EXECUTE def;
    RETURN 'enabled';
  ELSE
    IF position('_assert_vendor_not_banned' IN def) = 0 THEN
      RETURN 'already_disabled';
    END IF;
    def := replace(
      def,
      E'BEGIN\n  IF p_patch ? ''is_active'' AND (p_patch->>''is_active'')::boolean IS TRUE THEN\n    PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);\n  END IF;\n\n  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN',
      E'BEGIN\n  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN'
    );
    IF position('_assert_vendor_not_banned' IN def) > 0 THEN
      RAISE EXCEPTION 'failed to strip ban gate from vendor_update_own';
    END IF;
    EXECUTE def;
    RETURN 'disabled';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._test_set_vendor_update_own_ban_assert(boolean) IS
  'TEST-only: toggle ban assert inside vendor_update_own for A/B regression proof. service_role only.';

REVOKE ALL ON FUNCTION public._test_set_vendor_update_own_ban_assert(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._test_set_vendor_update_own_ban_assert(boolean) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Ban assert on appointment-path RPCs (match vendor_accept_order)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.vendor_fulfill_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET status = 'fulfilled'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_confirm_appointment(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET
    appointment_status = 'confirmed',
    status = 'accepted'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_decline_booking(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_cancel_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET
    appointment_status = 'declined',
    status = 'seen',
    cancel_reason = p_cancel_reason
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_cancel_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_cancel_reason text,
  p_cancel_appointment boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET
    status = 'cancelled',
    cancel_reason = p_cancel_reason,
    appointment_status = CASE
      WHEN p_cancel_appointment THEN 'cancelled'::text
      ELSE r.appointment_status
    END
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.order_bills
  SET payment_status = 'void'
  WHERE request_id = p_request_id
    AND payment_status <> 'paid';
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_mark_sent_seen(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET status = 'seen'
  FROM public.vendors v
  WHERE r.vendor_id = p_vendor_id
    AND r.status = 'sent'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_dismiss_requests(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.requests r
  SET status = 'done'
  FROM public.vendors v
  WHERE r.id = ANY (p_request_ids)
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_fulfill_order(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_fulfill_order(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_confirm_appointment(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_confirm_appointment(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_decline_booking(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_decline_booking(uuid, uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_mark_sent_seen(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_mark_sent_seen(uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4 + 8. create_customer_request: vendor ban/discoverable + customer ban
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_vendor_banned boolean;
  v_vendor_discoverable boolean;
  v_vendor_profile_status text;
  v_customer_banned boolean;
  v_category_id uuid;
  v_service_mode text;
  v_category_scalar text;
  v_vendor_scalar text;
  v_category_modes text[];
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  -- Customer ban gate (ParchiSheet trustBlock was client-only).
  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    SELECT COALESCE(u.is_banned, false)
    INTO v_customer_banned
    FROM public.users u
    WHERE u.phone = btrim(p_user_phone)
    LIMIT 1;

    IF COALESCE(v_customer_banned, false) THEN
      RAISE EXCEPTION 'customer_banned';
    END IF;
  END IF;

  SELECT
    v.is_active,
    COALESCE(v.is_banned, false),
    COALESCE(v.discoverable, false),
    v.profile_status
  INTO
    v_vendor_active,
    v_vendor_banned,
    v_vendor_discoverable,
    v_vendor_profile_status
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  -- Match vendors_public_discoverable_read RLS.
  IF v_vendor_banned THEN
    RAISE EXCEPTION 'vendor_banned';
  END IF;
  IF v_vendor_discoverable IS NOT TRUE OR COALESCE(v_vendor_profile_status, '') <> 'complete' THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
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

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid, text
) IS
  'Create customer request. Rejects banned/non-discoverable vendors and banned customers. Validates service_mode against category modes.';

REVOKE ALL ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid, text
) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Phone ownership on attach_pending_category / promote_green_pending*
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.attach_pending_category(uuid, uuid, text, text[]);
DROP FUNCTION IF EXISTS public.attach_pending_category(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.attach_pending_category(
  p_vendor_id uuid,
  p_vendor_phone text,
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
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

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

COMMENT ON FUNCTION public.attach_pending_category(uuid, text, uuid, text, text[]) IS
  'Replaces all vendor_categories with one pending/new category row. Requires vendor phone ownership.';

REVOKE ALL ON FUNCTION public.attach_pending_category(uuid, text, uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_pending_category(uuid, text, uuid, text, text[])
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.vendor_promote_green_pending(uuid);

CREATE OR REPLACE FUNCTION public.vendor_promote_green_pending(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.vendors v
  SET verification_status = 'green_pending'
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone)
    AND v.verification_status = 'business_verified'
    AND v.is_manual_verified IS NOT TRUE
    AND v.shop_photo_url IS NOT NULL
    AND v.photo_selfie IS NOT NULL
    AND trim(v.photo_selfie) <> ''
    AND v.upi_verified IS TRUE
    AND regexp_replace(COALESCE(v.phone, ''), '[\s-]', '', 'g') ~ '^(\+?91)?[6-9][0-9]{9}$';

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.vendor_promote_green_pending(uuid, text) IS
  'Marks green_pending when full green criteria met incl. selfie. Requires phone ownership.';

REVOKE ALL ON FUNCTION public.vendor_promote_green_pending(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_promote_green_pending(uuid, text)
  TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.vendor_promote_category_green_pending(uuid, uuid);

CREATE OR REPLACE FUNCTION public.vendor_promote_category_green_pending(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upi boolean;
  v_selfie text;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT COALESCE(upi_verified, false), photo_selfie
  INTO v_upi, v_selfie
  FROM public.vendors
  WHERE id = p_vendor_id
    AND phone = trim(p_vendor_phone);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT COALESCE(v_upi, false) THEN
    RETURN false;
  END IF;
  IF v_selfie IS NULL OR trim(v_selfie) = '' THEN
    RETURN false;
  END IF;

  UPDATE public.vendor_categories
  SET verification_status = 'green_pending'
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id
    AND is_manual_verified = false
    AND shop_photo_url IS NOT NULL
    AND trim(shop_photo_url) <> ''
    AND COALESCE(verification_status, '') IS DISTINCT FROM 'green_pending';

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.vendor_promote_category_green_pending(uuid, text, uuid) IS
  'Marks a business green_pending when photo + UPI + selfie done. Requires phone ownership.';

REVOKE ALL ON FUNCTION public.vendor_promote_category_green_pending(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_promote_category_green_pending(uuid, text, uuid)
  TO anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Ban-aware feed
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.vendor_post_offer(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_content text,
  p_starts_at timestamptz DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_reach_radius_km numeric DEFAULT 5,
  p_target_audience text DEFAULT 'customers',
  p_target_category_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audience text;
  v_category_id uuid;
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'vendor_post_offer',
    'vendor_id',
    p_vendor_id::text,
    5,
    600
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  v_audience := COALESCE(NULLIF(trim(p_target_audience), ''), 'customers');
  IF v_audience NOT IN ('customers', 'vendors', 'both') THEN
    RAISE EXCEPTION 'invalid_target_audience';
  END IF;

  IF v_audience = 'customers' THEN
    v_category_id := NULL;
  ELSE
    v_category_id := p_target_category_id;
    IF v_category_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.categories c WHERE c.id = v_category_id
    ) THEN
      RAISE EXCEPTION 'invalid_target_category';
    END IF;
  END IF;

  INSERT INTO public.feed_posts (
    type,
    vendor_id,
    user_phone,
    content,
    is_hidden,
    starts_at,
    expires_at,
    image_url,
    lat,
    lng,
    reach_radius_km,
    target_audience,
    target_category_id
  )
  VALUES (
    'offer',
    p_vendor_id,
    p_vendor_phone,
    p_content,
    false,
    p_starts_at,
    p_expires_at,
    p_image_url,
    p_lat,
    p_lng,
    COALESCE(NULLIF(p_reach_radius_km, 0), 5),
    v_audience,
    v_category_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_post_offer(
  uuid, text, text, timestamptz, timestamptz, text, double precision, double precision,
  numeric, text, uuid
) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_local_feed_posts(
  p_reader_lat double precision,
  p_reader_lng double precision,
  p_limit integer DEFAULT 50,
  p_reader_radius_km integer DEFAULT NULL,
  p_reader_vendor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
  IF p_reader_lat IS NULL OR p_reader_lng IS NULL THEN
    RAISE EXCEPTION 'reader_location_required';
  END IF;

  -- FUTURE: Replace haversine distance check with pincode adjacency lookup
  -- Interface: p_reader_lat/lng stays the same, only internal filter changes
  -- Requires: pincode_adjacency table (data source: TBD)
  -- This comment intentional — do not remove

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 50), 100), 1);

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_data ORDER BY created_at DESC)
      FROM (
        SELECT
          jsonb_build_object(
            'id', fp.id,
            'user_phone', fp.user_phone,
            'vendor_id', fp.vendor_id,
            'type', fp.type,
            'content', fp.content,
            'expires_at', fp.expires_at,
            'image_url', fp.image_url,
            'lat', fp.lat,
            'lng', fp.lng,
            'reach_radius_km', fp.reach_radius_km,
            'flagged_count', fp.flagged_count,
            'is_hidden', fp.is_hidden,
            'created_at', fp.created_at,
            'recommended_vendor_id', fp.recommended_vendor_id,
            'recommended_vendor_name', fp.recommended_vendor_name,
            'recommended_vendor_phone', fp.recommended_vendor_phone,
            'target_audience', fp.target_audience,
            'target_category_id', fp.target_category_id,
            'vendors', CASE
              WHEN v.id IS NOT NULL THEN jsonb_build_object(
                'shop_name', v.shop_name,
                'category', v.category
              )
              ELSE NULL
            END,
            'recommended_vendor', CASE
              WHEN rv.id IS NOT NULL THEN jsonb_build_object(
                'shop_name', rv.shop_name,
                'service_mode', rv.service_mode
              )
              ELSE NULL
            END
          ) AS row_data,
          fp.created_at
        FROM public.feed_posts fp
        LEFT JOIN public.vendors v ON v.id = fp.vendor_id
        LEFT JOIN public.vendors rv ON rv.id = fp.recommended_vendor_id
        CROSS JOIN LATERAL (
          SELECT
            (
              6371 * 2 * asin(sqrt(
                power(sin(radians(fp.lat - p_reader_lat) / 2), 2)
                + cos(radians(p_reader_lat)) * cos(radians(fp.lat))
                  * power(sin(radians(fp.lng - p_reader_lng) / 2), 2)
              ))
            ) AS distance_km,
            CASE
              WHEN fp.type = 'recommendation'
                AND fp.recommended_vendor_id IS NOT NULL
              THEN LEAST(
                COALESCE(NULLIF(fp.reach_radius_km, 0), 5),
                COALESCE(NULLIF(rv.service_radius_km, 0), 5)
              )
              ELSE COALESCE(NULLIF(fp.reach_radius_km, 0), 5)
            END AS effective_reach_km
        ) geo
        WHERE fp.is_hidden = false
          AND (fp.expires_at IS NULL OR fp.expires_at > now())
          AND (fp.starts_at IS NULL OR fp.starts_at <= now())
          AND fp.lat IS NOT NULL
          AND fp.lng IS NOT NULL
          AND geo.distance_km <= LEAST(
            geo.effective_reach_km,
            COALESCE(p_reader_radius_km, geo.effective_reach_km)
          )
          AND public.feed_post_matches_reader_audience(
            fp.target_audience,
            fp.target_category_id,
            p_reader_vendor_id
          )
          -- Match vendors_public_discoverable_read: exclude banned author vendors.
          AND (fp.vendor_id IS NULL OR COALESCE(v.is_banned, false) = false)
        ORDER BY fp.created_at DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_local_feed_posts(
  double precision, double precision, integer, integer, uuid
) TO anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Atomic Edit Shop Details save
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.vendor_update_profile_and_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_patch jsonb,
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
BEGIN
  PERFORM public.vendor_update_own(p_vendor_id, p_vendor_phone, p_patch);
  PERFORM public.vendor_update_categories(
    p_vendor_id,
    COALESCE(NULLIF(trim(p_patch->>'phone'), ''), trim(p_vendor_phone)),
    p_category_ids,
    p_category_service_modes,
    p_category_modes,
    p_brand_names,
    p_serves_at_vendor_place,
    p_serves_at_customer_place,
    p_service_radius_km
  );
END;
$$;

COMMENT ON FUNCTION public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
) IS
  'Atomic Edit Shop Details: vendor_update_own + vendor_update_categories in one transaction.';

REVOKE ALL ON FUNCTION public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
) TO anon, authenticated, service_role;
