-- ROLLBACK for pause/billing (20260921* / 20260922*).
-- NOT APPLIED. Restores last main/PROD bodies (through 20260916120001)
-- of the six rewritten RPCs and DISABLEs the new vendor_categories triggers.
-- Does not drop tables/columns (pause_credit_days, vendor_billing_pauses, etc.).
-- TEST syntax-check: wrap in BEGIN; … ROLLBACK;

BEGIN;

-- ── Disable pause/billing triggers (no-op if missing) ──────────────────────
DO $disable$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vendor_categories_pause_history_trg',
    'vendor_categories_billing_pause_trg',
    'vendor_categories_pause_reminder_trg',
    'vendor_categories_pause_block_trg'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_trigger g
      JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'vendor_categories'
        AND g.tgname = t
        AND NOT g.tgisinternal
    ) THEN
      EXECUTE format('ALTER TABLE public.vendor_categories DISABLE TRIGGER %I', t);
    END IF;
  END LOOP;
END;
$disable$;


-- ── admin_update_app_config from 20260916120001 ──

CREATE OR REPLACE FUNCTION public.admin_update_app_config(
  p_admin_phone text,
  p_key text,
  p_value text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_whitelist text[] := ARRAY[
    'referral_enabled',
    'help_accept_timeout_hours',
    'help_accept_timeout_minutes',
    'help_near_deadline_minutes',
    'delivery_near_deadline_minutes',
    'appointment_near_deadline_minutes',
    'appointment_accept_timeout_hours',
    'vendor_stopped_minutes',
    'vendor_stopped_distance_meters',
    'max_order_message_chars',
    'referral_user_credit',
    'referral_vendor_credit_total',
    'referral_vendor_credit_m1',
    'referral_vendor_credit_m2',
    'referral_vendor_credit_m3',
    'referral_veteran_threshold_months',
    'vendor_trial_days',
    'vendor_subscription_price',
    'help_call_limit_seconds',
    'delivery_call_limit_seconds',
    'appointment_call_limit_seconds',
    'vendor_lead_notify_enabled',
    'localization_enabled',
    'lang_hindi_enabled',
    'lang_marathi_enabled',
    'exotel_secure_calling_enabled',
    'aadhaar_verification_enabled',
    'upi_verification_enabled',
    'ai_category_confidence_threshold',
    'feed_notification_radius_km',
    'app_base_url',
    'payments_enabled',
    'razorpay_key_id',
    'razorpay_kyc_date',
    'exotel_kyc_date',
    'exotel_credits_low_threshold_inr',
    'vendor_grace_period_days',
    'khata_amber_limit'
  ];
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF NULLIF(trim(p_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid key';
  END IF;
  IF NOT (trim(p_key) = ANY (v_whitelist)) THEN
    RAISE EXCEPTION 'key_not_allowed';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  INSERT INTO public.app_config (key, value)
  VALUES (trim(p_key), coalesce(p_value, ''))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON FUNCTION public.admin_update_app_config(text, text, text) IS
  'Admin app_config upsert; server-side whitelist mirrors ADMIN_CONFIG_WHITELIST in AdminConsole.tsx (key_not_allowed otherwise).';


-- ── vendor_update_category_profile from 20260831140001 (RETURNS void) ──
DROP FUNCTION IF EXISTS public.vendor_update_category_profile(uuid, text, uuid, jsonb);


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
DECLARE
  v_fee numeric;
  v_min numeric;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_patch ? 'inspection_fee' THEN
    IF p_patch->>'inspection_fee' IS NULL OR btrim(p_patch->>'inspection_fee') = '' THEN
      v_fee := NULL;
    ELSE
      v_fee := (p_patch->>'inspection_fee')::numeric;
      IF v_fee IS NOT NULL AND v_fee <= 0 THEN
        v_fee := NULL;
      END IF;
      IF v_fee IS NOT NULL AND v_fee > 99999 THEN
        RAISE EXCEPTION 'inspection_fee_invalid';
      END IF;
    END IF;
  END IF;

  IF p_patch ? 'min_delivery_order_amount' THEN
    IF p_patch->>'min_delivery_order_amount' IS NULL
       OR btrim(p_patch->>'min_delivery_order_amount') = '' THEN
      v_min := NULL;
    ELSE
      v_min := (p_patch->>'min_delivery_order_amount')::numeric;
      IF v_min IS NOT NULL AND v_min <= 0 THEN
        v_min := NULL;
      END IF;
      IF v_min IS NOT NULL AND v_min > 99999 THEN
        RAISE EXCEPTION 'min_delivery_order_amount_invalid';
      END IF;
    END IF;
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
    END,
    is_paused = CASE
      WHEN p_patch ? 'is_paused' THEN COALESCE((p_patch->>'is_paused')::boolean, false)
      ELSE vc.is_paused
    END,
    inspection_fee = CASE
      WHEN p_patch ? 'inspection_fee' THEN v_fee
      ELSE vc.inspection_fee
    END,
    min_delivery_order_amount = CASE
      WHEN p_patch ? 'min_delivery_order_amount' THEN v_min
      ELSE vc.min_delivery_order_amount
    END
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) IS
  'Owner patch of per-business note/reach/pause/inspection_fee/min_delivery_order_amount. Hybrid session assert when Auth is present.';

REVOKE ALL ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb)
  TO anon, authenticated;


-- ── create_customer_request from 20260905290001 ──

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
  p_service_mode text DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_service_location text DEFAULT NULL,
  p_client_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_banned boolean;
  v_vendor_discoverable boolean;
  v_vendor_deletion_requested_at timestamptz;
  v_customer_banned boolean;
  v_customer_deletion_requested_at timestamptz;
  v_category_id uuid;
  v_service_mode text;
  v_category_modes text[];
  v_service_location text;
  v_delivery_fulfillment_method text;
  v_delivery_payment_timing text;
  v_business_paused boolean;
  v_min_delivery numeric;
  v_items_total numeric;
  v_idem text;
  v_phone text;
BEGIN
  -- Booking gates identity/ban/discoverable — not is_active or profile_status.
  -- Offline-but-discoverable Delivery/Appointment vendors stay bookable by
  -- design (Radar keeps them visible). Help already filters offline vendors
  -- out of discovery, so no is_active reject is needed here.

  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  v_idem := NULLIF(btrim(COALESCE(p_client_idempotency_key, '')), '');

  IF v_idem IS NOT NULL THEN
    SELECT r.id
    INTO v_id
    FROM public.requests r
    WHERE r.client_idempotency_key = v_idem
      AND r.created_at > now() - interval '2 minutes'
      AND (
        CASE
          WHEN v_phone IS NOT NULL THEN r.user_phone = v_phone
          ELSE r.device_id = p_device_id
        END
      )
    ORDER BY r.created_at DESC
    LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  IF v_phone IS NOT NULL THEN
    SELECT COALESCE(u.is_banned, false), u.deletion_requested_at
    INTO v_customer_banned, v_customer_deletion_requested_at
    FROM public.users u
    WHERE u.phone = v_phone
    LIMIT 1;

    IF COALESCE(v_customer_banned, false) THEN
      RAISE EXCEPTION 'customer_banned';
    END IF;

    IF v_customer_deletion_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'customer_deletion_scheduled';
    END IF;
  END IF;

  IF public._customer_has_unresolved_digital_payment_block(p_user_phone, p_device_id) THEN
    RAISE EXCEPTION 'customer_payment_block';
  END IF;

  SELECT
    COALESCE(v.is_banned, false),
    COALESCE(v.discoverable, false),
    v.deletion_requested_at
  INTO
    v_vendor_banned,
    v_vendor_discoverable,
    v_vendor_deletion_requested_at
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF v_vendor_banned THEN
    RAISE EXCEPTION 'vendor_banned';
  END IF;

  IF v_vendor_deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'vendor_deletion_scheduled';
  END IF;

  IF NOT v_vendor_discoverable THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;

  SELECT category_id, service_mode
  INTO v_category_id, v_service_mode
  FROM public._resolve_booking_category(
    p_vendor_id,
    p_category_id,
    p_service_mode,
    p_delivery_slot,
    p_appointment_time
  );

  SELECT COALESCE(vc.is_paused, false)
  INTO v_business_paused
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = v_category_id
  LIMIT 1;

  IF COALESCE(v_business_paused, false) THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;

  SELECT COALESCE(array_agg(vcm.mode), ARRAY[]::text[])
  INTO v_category_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id AND vc.category_id = v_category_id;

  IF v_category_modes IS NOT NULL AND array_length(v_category_modes, 1) > 0 AND NOT (v_service_mode = ANY(v_category_modes)) THEN
    RAISE EXCEPTION 'service_mode_unavailable';
  END IF;

  v_service_location := NULLIF(btrim(p_service_location), '');
  IF v_service_location IS NOT NULL AND v_service_location NOT IN ('customer_place', 'vendor_place') THEN
    RAISE EXCEPTION 'invalid_service_location';
  END IF;

  v_delivery_fulfillment_method := NULL;
  v_delivery_payment_timing := NULL;
  IF v_service_mode = 'delivery' THEN
    SELECT
      vc.delivery_fulfillment_method,
      vc.delivery_payment_timing,
      vc.min_delivery_order_amount
    INTO v_delivery_fulfillment_method, v_delivery_payment_timing, v_min_delivery
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = v_category_id
    LIMIT 1;

    v_delivery_fulfillment_method := COALESCE(v_delivery_fulfillment_method, 'vendor');
    v_delivery_payment_timing := COALESCE(v_delivery_payment_timing, 'postpaid');
    IF v_delivery_fulfillment_method = 'vendor' THEN
      v_delivery_payment_timing := 'postpaid';
    END IF;

    IF v_min_delivery IS NOT NULL AND v_min_delivery > 0 THEN
      v_items_total := public._delivery_items_subtotal(p_items);
      IF v_items_total < v_min_delivery THEN
        RAISE EXCEPTION 'below_min_delivery_order';
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.requests (
      device_id,
      vendor_id,
      message,
      user_phone,
      delivery_address,
      delivery_slot,
      delivery_slot_deadline,
      appointment_time,
      appointment_status,
      customer_latitude,
      customer_longitude,
      category_id,
      service_mode,
      items,
      service_location,
      delivery_fulfillment_method,
      delivery_payment_timing,
      client_idempotency_key
    )
    VALUES (
      p_device_id,
      p_vendor_id,
      p_message,
      p_user_phone,
      p_delivery_address,
      p_delivery_slot,
      p_delivery_slot_deadline,
      p_appointment_time,
      p_appointment_status,
      p_customer_latitude,
      p_customer_longitude,
      v_category_id,
      v_service_mode,
      p_items,
      v_service_location,
      v_delivery_fulfillment_method,
      v_delivery_payment_timing,
      v_idem
    )
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF v_idem IS NULL THEN
        RAISE;
      END IF;
      SELECT r.id
      INTO v_id
      FROM public.requests r
      WHERE r.client_idempotency_key = v_idem
      LIMIT 1;
      IF v_id IS NULL THEN
        RAISE;
      END IF;
      RETURN v_id;
  END;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) IS
  'Create customer request. Gates ban/deletion/discoverable (not is_active). Offline discoverable Delivery/Appointment stay bookable by design; Help filters offline at discovery. Optional idempotency key.';


-- ── spawn_due_recurring_orders from 20260905280001 ──

CREATE OR REPLACE FUNCTION public.spawn_due_recurring_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_spawned integer := 0;
  v_request_id uuid;
  v_day date;
  v_deadline timestamptz;
  v_appt timestamptz;
  v_slot text;
  v_err text;
BEGIN
  v_day := (timezone('Asia/Kolkata', now()))::date;

  FOR rec IN
    SELECT *
    FROM public.recurring_orders
    WHERE status = 'active'
      AND next_run_at <= now()
    ORDER BY next_run_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    v_deadline := NULL;
    v_appt := NULL;
    v_slot := rec.delivery_slot;

    IF rec.service_mode = 'delivery' THEN
      v_deadline := public._delivery_slot_deadline_on(COALESCE(v_slot, 'evening'), v_day);
      IF v_deadline < now() THEN
        v_deadline := public._delivery_slot_deadline_on(
          COALESCE(v_slot, 'evening'),
          v_day + 1
        );
      END IF;
    ELSIF rec.service_mode = 'appointment' THEN
      v_appt := (v_day + COALESCE(rec.appointment_tod, time '10:00'))
        AT TIME ZONE 'Asia/Kolkata';
      IF v_appt < now() THEN
        v_appt := ((v_day + 1) + COALESCE(rec.appointment_tod, time '10:00'))
          AT TIME ZONE 'Asia/Kolkata';
      END IF;
    END IF;

    BEGIN
      v_request_id := public.create_customer_request(
        rec.device_id,
        rec.vendor_id,
        COALESCE(rec.message, ''),
        rec.user_phone,
        rec.device_id,
        rec.delivery_address,
        v_slot,
        v_deadline,
        v_appt,
        CASE WHEN rec.service_mode = 'appointment' THEN COALESCE(rec.appointment_status, 'pending') ELSE NULL END,
        rec.customer_latitude,
        rec.customer_longitude,
        false,
        rec.category_id,
        rec.service_mode,
        rec.items,
        rec.service_location
      );

      UPDATE public.requests
      SET recurring_order_id = rec.id
      WHERE id = v_request_id;

      UPDATE public.recurring_orders
      SET
        last_request_id = v_request_id,
        last_spawned_at = now(),
        next_run_at = public._advance_recurring_next_run(next_run_at, interval_days),
        updated_at = now()
      WHERE id = rec.id;

      v_spawned := v_spawned + 1;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err IN (
        'vendor_banned',
        'vendor_deletion_scheduled',
        'customer_banned',
        'customer_deletion_scheduled'
      ) THEN
        UPDATE public.recurring_orders
        SET
          status = 'paused',
          updated_at = now()
        WHERE id = rec.id;
      ELSE
        UPDATE public.recurring_orders
        SET
          next_run_at = public._advance_recurring_next_run(next_run_at, interval_days),
          updated_at = now()
        WHERE id = rec.id;
      END IF;
    END;
  END LOOP;

  RETURN v_spawned;
END;
$$;

COMMENT ON FUNCTION public.spawn_due_recurring_orders() IS
  'Cron + tests: spawn due active recurring arrangements; pause parent on permanent ban/deletion spawn failures.';

REVOKE ALL ON FUNCTION public.spawn_due_recurring_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spawn_due_recurring_orders() TO service_role;


-- ── get_radar_category_mode_matches from 20260830120001 ──

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
  JOIN public.vendors v ON v.id = vc.vendor_id
  WHERE vc.status = 'approved'
    AND COALESCE(vc.is_paused, false) = false
    AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    AND v.deletion_requested_at IS NULL
    AND vcm.mode = lower(trim(p_mode))
    AND (
      p_category_ids IS NULL
      OR cardinality(p_category_ids) = 0
      OR vc.category_id = ANY (p_category_ids)
    );
$$;

COMMENT ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) IS
  'Radar discovery: approved unpaused vendor/category pairs offering the given availability mode; excludes pending_location_review and scheduled-deletion vendors.';

REVOKE ALL ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_radar_category_mode_matches(text, uuid[])
  TO anon, authenticated, service_role;


-- ── _resolve_booking_category from 20260830120001 ──

CREATE OR REPLACE FUNCTION public._resolve_booking_category(
  p_vendor_id uuid,
  p_hint_category_id uuid DEFAULT NULL,
  p_hint_service_mode text DEFAULT NULL,
  p_delivery_slot text DEFAULT NULL,
  p_appointment_time timestamptz DEFAULT NULL
)
RETURNS TABLE(category_id uuid, service_mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_id uuid;
  v_service_mode text;
  v_category_scalar text;
  v_vendor_scalar text;
  v_category_modes text[];
BEGIN
  IF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = false
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
  ) THEN
    v_category_id := p_hint_category_id;
  ELSIF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND vc.verification_status = 'pending_location_review'
  ) THEN
    RAISE EXCEPTION 'category_location_review_pending';
  ELSIF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = true
  ) THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = false
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id AND vc.status = 'approved'
      ) THEN
        -- Approved businesses exist but all are paused or pending location review.
        RAISE EXCEPTION 'vendor_not_discoverable';
      END IF;
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

  IF p_hint_service_mode IS NOT NULL AND trim(p_hint_service_mode) <> '' THEN
    v_service_mode := lower(trim(p_hint_service_mode));
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

  category_id := v_category_id;
  service_mode := v_service_mode;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) IS
  'Resolve category_id and service_mode for booking. Skips paused and pending_location_review businesses.';

REVOKE ALL ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz)
  TO anon, authenticated, service_role;


-- Default ends in ROLLBACK so this file cannot persist if run as-is.
-- To actually roll back PROD/TEST: replace ROLLBACK with COMMIT.
ROLLBACK;
