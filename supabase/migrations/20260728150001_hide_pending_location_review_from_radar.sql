-- Hide pending_location_review from customer discovery / booking.
-- Keep vendor_categories.status = 'approved' unchanged (registration + other logic).
-- Widen admin green-pending stats to include location-review soft-fails.

-- Shared predicate (inline everywhere):
--   vc.status = 'approved'
--   AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'

-- ── 1. Radar discovery ──────────────────────────────────────────────────────

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
    AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    AND vcm.mode = lower(trim(p_mode))
    AND (
      p_category_ids IS NULL
      OR cardinality(p_category_ids) = 0
      OR vc.category_id = ANY (p_category_ids)
    );
$$;

COMMENT ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) IS
  'Radar discovery: approved vendor/category pairs offering the given availability mode; excludes pending_location_review.';

-- ── 2. Booking: create_customer_request category resolution ─────────────────

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

  -- Customer-visible categories only (approved, not pending location review).
  IF p_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
      AND vc.status = 'approved'
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
  ) THEN
    v_category_id := p_category_id;
  ELSIF p_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
      AND vc.status = 'approved'
      AND vc.verification_status = 'pending_location_review'
  ) THEN
    RAISE EXCEPTION 'category_location_review_pending';
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
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
  'Create customer request. Rejects banned/non-discoverable vendors, banned customers, and categories in pending_location_review.';

-- ── 3. Admin health: include pending_location_review in review counts ───────

CREATE OR REPLACE FUNCTION public.get_admin_green_pending_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_pending bigint;
  v_category_pending bigint;
  v_vendors_ready bigint;
BEGIN
  IF NOT public.is_admin_session()
     AND coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(*) INTO v_account_pending
  FROM public.vendors
  WHERE verification_status IN ('green_pending', 'pending_location_review')
    AND is_manual_verified = false;

  SELECT count(*) INTO v_category_pending
  FROM public.vendor_categories
  WHERE verification_status IN ('green_pending', 'pending_location_review')
    AND is_manual_verified = false;

  SELECT count(*) INTO v_vendors_ready
  FROM public.vendors v
  WHERE (v.verification_status IN ('green_pending', 'pending_location_review')
         AND v.is_manual_verified = false)
     OR EXISTS (
       SELECT 1 FROM public.vendor_categories vc
       WHERE vc.vendor_id = v.id
         AND vc.verification_status IN ('green_pending', 'pending_location_review')
         AND vc.is_manual_verified = false
     );

  RETURN jsonb_build_object(
    'account_pending', coalesce(v_account_pending, 0),
    'category_pending', coalesce(v_category_pending, 0),
    'vendors_ready', coalesce(v_vendors_ready, 0)
  );
END;
$$;

COMMENT ON FUNCTION public.get_admin_green_pending_stats() IS
  'Admin health: vendors/businesses at green_pending or pending_location_review awaiting admin review.';

-- Patch dashboard green_pending_vendors count without rewriting the whole RPC:
-- recreate only the count expression via a thin wrapper replacement of the
-- dashboard function's green_pending section. Full body mirrored from
-- 20260719100001 with the widened verification_status filter.

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stuck_cutoff timestamptz := now() - interval '24 hours';
  v_start_of_today timestamptz := date_trunc('day', now());
  v_start_of_week timestamptz := date_trunc('week', now());
  v_total_orders integer;
  v_orders_today integer;
  v_orders_this_week integer;
  v_total_vendors integer;
  v_total_customers integer;
  v_stuck_orders integer;
  v_active_vendors_today integer;
  v_new_vendors_this_week integer;
  v_unverified_vendors integer;
  v_green_pending_vendors integer;
  v_risky_users integer;
  v_total_referrals integer;
  v_avg_vendor_rating numeric;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT count(*)::integer INTO v_total_orders FROM public.requests;
  SELECT count(*)::integer INTO v_orders_today
  FROM public.requests WHERE created_at >= v_start_of_today;
  SELECT count(*)::integer INTO v_orders_this_week
  FROM public.requests WHERE created_at >= v_start_of_week;
  SELECT count(*)::integer INTO v_total_vendors FROM public.vendors;
  SELECT count(*)::integer INTO v_total_customers FROM public.users;
  SELECT count(*)::integer INTO v_stuck_orders
  FROM public.requests
  WHERE status IN ('sent', 'accepted') AND created_at < v_stuck_cutoff;
  SELECT count(*)::integer INTO v_active_vendors_today
  FROM public.vendors
  WHERE is_active = true AND last_updated >= v_start_of_today;
  SELECT count(*)::integer INTO v_new_vendors_this_week
  FROM public.vendors WHERE created_at >= v_start_of_week;
  SELECT count(*)::integer INTO v_unverified_vendors
  FROM public.vendors WHERE is_manual_verified = false;

  SELECT count(*)::integer INTO v_green_pending_vendors
  FROM public.vendors v
  WHERE (v.verification_status IN ('green_pending', 'pending_location_review')
         AND v.is_manual_verified = false)
     OR EXISTS (
       SELECT 1 FROM public.vendor_categories vc
       WHERE vc.vendor_id = v.id
         AND vc.verification_status IN ('green_pending', 'pending_location_review')
         AND vc.is_manual_verified = false
     );

  SELECT count(*)::integer INTO v_risky_users
  FROM public.users WHERE trust_score < 25 AND is_banned = false;
  SELECT count(*)::integer INTO v_total_referrals FROM public.referrals;

  SELECT round(avg(avg_rating)::numeric, 1) INTO v_avg_vendor_rating
  FROM public.vendors
  WHERE avg_rating > 0 AND is_active = true;

  RETURN jsonb_build_object(
    'total_orders', COALESCE(v_total_orders, 0),
    'orders_today', COALESCE(v_orders_today, 0),
    'orders_this_week', COALESCE(v_orders_this_week, 0),
    'total_vendors', COALESCE(v_total_vendors, 0),
    'total_customers', COALESCE(v_total_customers, 0),
    'stuck_orders', COALESCE(v_stuck_orders, 0),
    'active_vendors_today', COALESCE(v_active_vendors_today, 0),
    'new_vendors_this_week', COALESCE(v_new_vendors_this_week, 0),
    'unverified_vendors', COALESCE(v_unverified_vendors, 0),
    'green_pending_vendors', COALESCE(v_green_pending_vendors, 0),
    'risky_users', COALESCE(v_risky_users, 0),
    'total_referrals', COALESCE(v_total_referrals, 0),
    'avg_vendor_rating', COALESCE(v_avg_vendor_rating, 0)
  );
END;
$$;
