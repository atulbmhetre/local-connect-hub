-- Pause history, open-work gate, preflight, placement FOR SHARE, recurring skip notice.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Pause stays per-business (vendor_categories / requests.category_id), not per-account.

-- ── 1. paused_at + pause events ──────────────────────────────────────────────

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS paused_at timestamptz NULL;

COMMENT ON COLUMN public.vendor_categories.paused_at IS
  'Set when is_paused becomes true; cleared on resume. History rows live in vendor_pause_events.';

CREATE TABLE IF NOT EXISTS public.vendor_pause_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories (id) ON DELETE CASCADE,
  paused_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz NULL
);

COMMENT ON TABLE public.vendor_pause_events IS
  'One row per pause episode. Written only by vendor_categories_pause_history trigger.';

CREATE INDEX IF NOT EXISTS vendor_pause_events_vendor_category_idx
  ON public.vendor_pause_events (vendor_id, category_id, paused_at DESC);

ALTER TABLE public.vendor_pause_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_pause_events_owner_read ON public.vendor_pause_events;
CREATE POLICY vendor_pause_events_owner_read ON public.vendor_pause_events
  FOR SELECT
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT v.id FROM public.vendors v WHERE v.phone = public.auth_user_phone()
    )
  );

REVOKE ALL ON public.vendor_pause_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vendor_pause_events TO anon, authenticated;

CREATE OR REPLACE FUNCTION public._vendor_categories_pause_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.is_paused IS DISTINCT FROM OLD.is_paused THEN
    IF NEW.is_paused = true AND COALESCE(OLD.is_paused, false) = false THEN
      NEW.paused_at := now();
      INSERT INTO public.vendor_pause_events (vendor_id, category_id, paused_at, resumed_at)
      VALUES (NEW.vendor_id, NEW.category_id, NEW.paused_at, NULL);
    ELSIF NEW.is_paused = false AND COALESCE(OLD.is_paused, false) = true THEN
      NEW.paused_at := NULL;
      UPDATE public.vendor_pause_events e
      SET resumed_at = now()
      WHERE e.id = (
        SELECT x.id
        FROM public.vendor_pause_events x
        WHERE x.vendor_id = NEW.vendor_id
          AND x.category_id = NEW.category_id
          AND x.resumed_at IS NULL
        ORDER BY x.paused_at DESC
        LIMIT 1
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_categories_pause_history_trg ON public.vendor_categories;
CREATE TRIGGER vendor_categories_pause_history_trg
  BEFORE UPDATE OF is_paused ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public._vendor_categories_pause_history();

UPDATE public.vendor_categories
SET paused_at = now()
WHERE is_paused = true
  AND paused_at IS NULL;

INSERT INTO public.vendor_pause_events (vendor_id, category_id, paused_at, resumed_at)
SELECT vc.vendor_id, vc.category_id, vc.paused_at, NULL
FROM public.vendor_categories vc
WHERE vc.is_paused = true
  AND vc.paused_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.vendor_pause_events e
    WHERE e.vendor_id = vc.vendor_id
      AND e.category_id = vc.category_id
      AND e.resumed_at IS NULL
  );

-- ── 2. app_config + admin whitelist ──────────────────────────────────────────

SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value, default_value)
VALUES
  ('pause_min_credit_days', '7', '7'),
  ('pause_min_live_days', '7', '7'),
  ('pause_reminder_interval_days', '30', '30')
ON CONFLICT (key) DO UPDATE
SET default_value = COALESCE(public.app_config.default_value, EXCLUDED.default_value);
RESET app.via_admin_rpc;

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
    'khata_amber_limit',
    'pause_min_credit_days',
    'pause_min_live_days',
    'pause_reminder_interval_days'
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

-- ── 3. Open-work counts (per business) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public._vendor_business_open_work_counts(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'help', COALESCE(SUM(CASE WHEN r.service_mode = 'help' THEN 1 ELSE 0 END), 0),
    'delivery', COALESCE(SUM(CASE WHEN r.service_mode = 'delivery' THEN 1 ELSE 0 END), 0),
    'appointment', COALESCE(SUM(CASE WHEN r.service_mode = 'appointment' THEN 1 ELSE 0 END), 0)
  )
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id
    AND r.category_id = p_category_id
    AND r.status IN ('sent', 'seen', 'accepted')
    AND COALESCE(r.appointment_status, '') NOT IN ('declined', 'cancelled');
$$;

COMMENT ON FUNCTION public._vendor_business_open_work_counts(uuid, uuid) IS
  'Internal: open request counts by mode for one vendor_categories business. Open = sent|seen|accepted excluding declined/cancelled appointments.';

REVOKE ALL ON FUNCTION public._vendor_business_open_work_counts(uuid, uuid) FROM PUBLIC;

-- ── 4. Preflight RPC ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_pause_preflight(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_sub text;
  v_counts jsonb;
  v_help integer;
  v_delivery integer;
  v_appointment integer;
  v_open_total integer;
  v_khata_amount numeric;
  v_khata_customers integer;
  v_upi_claims integer;
  v_credit_days integer;
  v_will_freeze boolean;
  v_block text;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, NULL);

  SELECT v.phone, v.subscription_status
  INTO v_phone, v_sub
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
  ) THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  v_counts := public._vendor_business_open_work_counts(p_vendor_id, p_category_id);
  v_help := COALESCE((v_counts->>'help')::integer, 0);
  v_delivery := COALESCE((v_counts->>'delivery')::integer, 0);
  v_appointment := COALESCE((v_counts->>'appointment')::integer, 0);
  v_open_total := v_help + v_delivery + v_appointment;

  SELECT
    COALESCE(SUM(kl.total_outstanding) FILTER (WHERE kl.total_outstanding > 0), 0),
    COUNT(*) FILTER (WHERE kl.total_outstanding > 0)
  INTO v_khata_amount, v_khata_customers
  FROM public.khata_ledger kl
  WHERE kl.vendor_id = p_vendor_id;

  SELECT COUNT(*)::integer
  INTO v_upi_claims
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id
    AND r.category_id = p_category_id
    AND r.payment_status = 'claimed';

  SELECT COALESCE(NULLIF(trim(value), '')::integer, 7)
  INTO v_credit_days
  FROM public.app_config
  WHERE key = 'pause_min_credit_days';
  v_credit_days := COALESCE(v_credit_days, 7);

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND vc.category_id IS DISTINCT FROM p_category_id
      AND COALESCE(vc.is_paused, false) = false
  )
  INTO v_will_freeze;

  v_block := NULL;
  IF v_open_total > 0 THEN
    v_block := 'open_work';
  ELSIF v_sub IN ('grace', 'expired') THEN
    v_block := 'subscription_state';
  END IF;

  RETURN jsonb_build_object(
    'can_pause', v_block IS NULL,
    'block_reason', v_block,
    'open_work', jsonb_build_object(
      'help', v_help,
      'delivery', v_delivery,
      'appointment', v_appointment
    ),
    'khata', jsonb_build_object(
      'pending_amount', v_khata_amount,
      'customer_count', v_khata_customers
    ),
    'upi_claims_pending', v_upi_claims,
    'subscription_status', v_sub,
    'will_freeze_billing', v_will_freeze,
    'pause_min_credit_days', v_credit_days
  );
END;
$$;

COMMENT ON FUNCTION public.vendor_pause_preflight(uuid, uuid) IS
  'Owner preflight before pausing one business. Hybrid session assert when Auth is present.';

REVOKE ALL ON FUNCTION public.vendor_pause_preflight(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_pause_preflight(uuid, uuid)
  TO anon, authenticated, service_role;

-- ── 5. Enforce pause gate on vendor_update_category_profile ──────────────────

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
  v_was_paused boolean;
  v_want_paused boolean;
  v_counts jsonb;
  v_help integer;
  v_delivery integer;
  v_appointment integer;
  v_sub text;
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

  SELECT COALESCE(vc.is_paused, false)
  INTO v_was_paused
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF p_patch ? 'is_paused' THEN
    v_want_paused := COALESCE((p_patch->>'is_paused')::boolean, false);
    IF v_want_paused = true AND COALESCE(v_was_paused, false) = false THEN
      v_counts := public._vendor_business_open_work_counts(p_vendor_id, p_category_id);
      v_help := COALESCE((v_counts->>'help')::integer, 0);
      v_delivery := COALESCE((v_counts->>'delivery')::integer, 0);
      v_appointment := COALESCE((v_counts->>'appointment')::integer, 0);
      IF (v_help + v_delivery + v_appointment) > 0 THEN
        RAISE EXCEPTION 'pause_blocked_open_work'
          USING DETAIL = jsonb_build_object(
            'help', v_help,
            'delivery', v_delivery,
            'appointment', v_appointment
          )::text;
      END IF;

      SELECT v.subscription_status
      INTO v_sub
      FROM public.vendors v
      WHERE v.id = p_vendor_id
      LIMIT 1;

      IF v_sub IN ('grace', 'expired') THEN
        RAISE EXCEPTION 'pause_blocked_subscription'
          USING DETAIL = jsonb_build_object(
            'subscription_status', v_sub,
            'help', v_help,
            'delivery', v_delivery,
            'appointment', v_appointment
          )::text;
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
  'Owner patch of per-business note/reach/pause/inspection_fee/min_delivery_order_amount. Pause false->true refused when the business has open work or subscription is grace/expired. Hybrid session assert when Auth is present.';

REVOKE ALL ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb)
  TO anon, authenticated;

-- ── 6. create_customer_request: FOR SHARE on pause row ───────────────────────

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
  LIMIT 1
  FOR SHARE;

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
  'Create customer request. Gates ban/deletion/discoverable (not is_active). Offline discoverable Delivery/Appointment stay bookable by design; Help filters offline at discovery. Optional idempotency key. Pause check takes FOR SHARE.';

REVOKE ALL ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) TO anon, authenticated, service_role;

-- ── 7. Recurring skip notice ─────────────────────────────────────────────────

ALTER TABLE public.recurring_orders
  ADD COLUMN IF NOT EXISTS skip_notified_at timestamptz NULL;

COMMENT ON COLUMN public.recurring_orders.skip_notified_at IS
  'Set after one customer notice that a spawn was skipped because the business is paused; cleared on the next successful spawn.';

INSERT INTO public.notification_i18n (copy_key, lang, title, body)
VALUES
  (
    'recurring_skipped_paused',
    'en',
    'Recurring order skipped',
    '{shop_name} is on a break, so today''s recurring order was skipped. It will continue when they are back.'
  ),
  (
    'recurring_skipped_paused',
    'hi',
    'आवर्ती ऑर्डर नहीं भेजा गया',
    '{shop_name} फिलहाल बंद हैं, इसलिए आज का आवर्ती ऑर्डर नहीं भेजा गया। वे वापस आने पर यह जारी रहेगा।'
  ),
  (
    'recurring_skipped_paused',
    'mr',
    'आवर्ती ऑर्डर वगळला',
    '{shop_name} सध्या बंद आहेत, म्हणून आजचा आवर्ती ऑर्डर पाठवला नाही. ते परत आल्यावर तो सुरू राहील.'
  )
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

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
  v_paused boolean;
  v_notify boolean;
  v_shop text;
  v_title text;
  v_body text;
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
        skip_notified_at = NULL,
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
        v_notify := false;
        IF v_err = 'vendor_not_discoverable'
           AND rec.category_id IS NOT NULL
           AND rec.skip_notified_at IS NULL
           AND NULLIF(btrim(COALESCE(rec.user_phone, '')), '') IS NOT NULL
        THEN
          SELECT COALESCE(vc.is_paused, false)
          INTO v_paused
          FROM public.vendor_categories vc
          WHERE vc.vendor_id = rec.vendor_id
            AND vc.category_id = rec.category_id
          LIMIT 1;

          IF COALESCE(v_paused, false) THEN
            SELECT COALESCE(NULLIF(btrim(v.shop_name), ''), NULLIF(btrim(v.name), ''), 'Vendor')
            INTO v_shop
            FROM public.vendors v
            WHERE v.id = rec.vendor_id;

            SELECT f.title, f.body
            INTO v_title, v_body
            FROM public.notification_i18n_format(
              'recurring_skipped_paused',
              rec.user_phone,
              jsonb_build_object('shop_name', v_shop)
            ) f;

            INSERT INTO public.user_notifications (
              user_phone, type, title, body, route, is_informational
            )
            VALUES (
              rec.user_phone,
              'recurring_skipped_paused',
              v_title,
              v_body,
              'my-orders',
              true
            );
            v_notify := true;
          END IF;
        END IF;

        UPDATE public.recurring_orders
        SET
          next_run_at = public._advance_recurring_next_run(next_run_at, interval_days),
          skip_notified_at = CASE WHEN v_notify THEN now() ELSE skip_notified_at END,
          updated_at = now()
        WHERE id = rec.id;
      END IF;
    END;
  END LOOP;

  RETURN v_spawned;
END;
$$;

COMMENT ON FUNCTION public.spawn_due_recurring_orders() IS
  'Cron + tests: spawn due active recurring arrangements; pause parent on permanent ban/deletion spawn failures. One customer notice when skipped because the business is paused.';

REVOKE ALL ON FUNCTION public.spawn_due_recurring_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spawn_due_recurring_orders() TO service_role;
