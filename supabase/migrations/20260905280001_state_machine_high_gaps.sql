-- High-severity state-machine gaps:
-- 1) Help expire includes seen (not only sent)
-- 2) Admin resolve disputed UPI -> confirmed|void (+ bill paid|void)
-- 3) vendor_cancel_order only from sent|seen|accepted
-- 4) Pause recurring parent on permanent spawn failures (ban/deletion)

CREATE OR REPLACE FUNCTION public.expire_pending_orders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $expire$
DECLARE
  help_accept_timeout_minutes integer;
  appointment_accept_timeout_hours integer;
  notify_url text;
  notify_anon_key text;
  rec record;
BEGIN
  SELECT NULLIF(trim(value), '')
  INTO notify_url
  FROM public.app_config
  WHERE key = 'edge_function_url';

  SELECT NULLIF(trim(value), '')
  INTO notify_anon_key
  FROM public.app_config
  WHERE key = 'anon_key';

  IF notify_url IS NULL THEN
    RAISE EXCEPTION 'app_config key edge_function_url is missing or invalid';
  END IF;

  IF notify_anon_key IS NULL THEN
    RAISE EXCEPTION 'app_config key anon_key is missing or invalid';
  END IF;

  notify_url := notify_url || '/notify-user';

  PERFORM public.warn_pending_orders_near_deadline();

  CREATE TEMP TABLE IF NOT EXISTS _expire_push_phones (
    user_phone text PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE _expire_push_phones;

  -- Drop if present so a prior session shape (notify_body) cannot conflict.
  DROP TABLE IF EXISTS _expired_for_notify;
  CREATE TEMP TABLE _expired_for_notify (
    request_id uuid PRIMARY KEY,
    user_phone text NOT NULL,
    copy_key text NOT NULL,
    replacements jsonb NOT NULL DEFAULT '{}'::jsonb
  ) ON COMMIT DROP;

  SELECT NULLIF(trim(value), '')::integer
  INTO help_accept_timeout_minutes
  FROM public.app_config
  WHERE key = 'help_accept_timeout_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO appointment_accept_timeout_hours
  FROM public.app_config
  WHERE key = 'appointment_accept_timeout_hours';

  IF help_accept_timeout_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key help_accept_timeout_minutes is missing or invalid';
  END IF;

  IF appointment_accept_timeout_hours IS NULL THEN
    RAISE EXCEPTION 'app_config key appointment_accept_timeout_hours is missing or invalid';
  END IF;

  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'help'
      AND r.status IN ('sent', 'seen')
      AND r.created_at + (help_accept_timeout_minutes || ' minutes')::interval < now()
    RETURNING r.id, r.user_phone
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, copy_key, replacements)
  SELECT e.id, trim(e.user_phone), 'order_expired', '{}'::jsonb
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'delivery'
      AND r.status IN ('sent', 'seen')
      AND r.delivery_slot_deadline IS NOT NULL
      AND r.delivery_slot_deadline < now()
    RETURNING r.id, r.user_phone, r.delivery_slot
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, copy_key, replacements)
  SELECT
    e.id,
    trim(e.user_phone),
    'order_expired_delivery',
    jsonb_build_object(
      'slot',
      CASE COALESCE(e.delivery_slot, '')
        WHEN 'morning' THEN 'morning slot'
        WHEN 'evening' THEN 'evening slot'
        WHEN 'night' THEN 'night slot'
        ELSE 'your delivery slot'
      END
    )
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH expired AS (
    UPDATE public.requests r
    SET
      status = 'expired',
      appointment_status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'appointment'
      AND r.status IN ('sent', 'seen')
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND r.appointment_time < now()
    RETURNING r.id, r.user_phone, r.appointment_time
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, copy_key, replacements)
  SELECT
    e.id,
    trim(e.user_phone),
    'order_expired_appointment',
    jsonb_build_object(
      'when',
      COALESCE(
        TO_CHAR(e.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
        ''
      )
    )
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH reps AS (
    SELECT DISTINCT ON (user_phone)
      request_id,
      user_phone,
      copy_key,
      replacements
    FROM _expired_for_notify
    ORDER BY user_phone, request_id
  ),
  inserted AS (
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route,
      route_params,
      related_id,
      is_informational
    )
    SELECT
      r.user_phone,
      'order_expired',
      (SELECT f.title FROM public.notification_i18n_format(r.copy_key, r.user_phone, r.replacements) f),
      (SELECT f.body FROM public.notification_i18n_format(r.copy_key, r.user_phone, r.replacements) f),
      'my-orders',
      jsonb_build_object('order_id', r.request_id),
      r.request_id,
      false
    FROM reps r
    RETURNING user_phone
  )
  INSERT INTO _expire_push_phones (user_phone)
  SELECT DISTINCT trim(user_phone)
  FROM inserted
  ON CONFLICT (user_phone) DO NOTHING;

  FOR rec IN
    SELECT DISTINCT ON (user_phone)
      user_phone,
      copy_key,
      replacements
    FROM _expired_for_notify
    ORDER BY user_phone, request_id
  LOOP
    PERFORM net.http_post(
      url := notify_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || notify_anon_key
      ),
      body := jsonb_build_object(
        'user_phone', rec.user_phone,
        'title', (SELECT f.title FROM public.notification_i18n_format(rec.copy_key, rec.user_phone, rec.replacements) f),
        'body', (SELECT f.body FROM public.notification_i18n_format(rec.copy_key, rec.user_phone, rec.replacements) f),
        'type', 'order_expired',
        'route', 'my-orders',
        'skip_inbox', true
      )
    );
  END LOOP;
END;
$expire$;

COMMENT ON FUNCTION public.expire_pending_orders() IS
  'Expires overdue help/delivery/appointment requests (Help: sent|seen), writes localized inbox notices, and FCM-notifies with skip_inbox.';

-- ============================================================================
-- 2) Admin resolve disputed UPI
-- ============================================================================

ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_payment_status_check;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_payment_status_check
  CHECK (payment_status IN ('unpaid', 'claimed', 'confirmed', 'disputed', 'void'));

CREATE OR REPLACE FUNCTION public.admin_resolve_disputed_upi_payment(
  p_request_id uuid,
  p_resolution text,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_resolution text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF NULLIF(btrim(COALESCE(p_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  v_resolution := lower(btrim(COALESCE(p_resolution, '')));
  IF v_resolution IS DISTINCT FROM 'confirmed' AND v_resolution IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION 'invalid_resolution';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT r.payment_status
  INTO v_status
  FROM public.requests r
  WHERE r.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_status IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION 'payment_not_disputed';
  END IF;

  IF v_resolution = 'confirmed' THEN
    UPDATE public.requests
    SET payment_status = 'confirmed',
        payment_confirmed_at = now()
    WHERE id = p_request_id
      AND payment_status = 'disputed';

    UPDATE public.order_bills
    SET payment_status = 'paid',
        paid_at = COALESCE(paid_at, now())
    WHERE request_id = p_request_id
      AND payment_status = 'unpaid';
  ELSE
    UPDATE public.requests
    SET payment_status = 'void'
    WHERE id = p_request_id
      AND payment_status = 'disputed';

    UPDATE public.order_bills
    SET payment_status = 'void'
    WHERE request_id = p_request_id
      AND payment_status <> 'paid';
  END IF;

  PERFORM public.log_admin_action(
    NULL,
    'resolve_disputed_upi',
    'request',
    p_request_id::text,
    btrim(p_notes) || ' [' || v_resolution || ']'
  );
END;
$$;

COMMENT ON FUNCTION public.admin_resolve_disputed_upi_payment(uuid, text, text) IS
  'Admin session only: resolve disputed UPI to confirmed (bill paid) or void (bill voided). Reason required.';

REVOKE ALL ON FUNCTION public.admin_resolve_disputed_upi_payment(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_resolve_disputed_upi_payment(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_disputed_upi_payment(uuid, text, text) TO authenticated;

-- Treat void like other terminal payment states for the 48h digital-payment block.
CREATE OR REPLACE FUNCTION public._customer_find_blocking_digital_payment_bill(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid,
  vendor_name text,
  amount double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id AS request_id,
    COALESCE(
      NULLIF(btrim(v.shop_name), ''),
      NULLIF(btrim(v.name), ''),
      'Vendor'
    ) AS vendor_name,
    ob.total_amount AS amount
  FROM public.order_bills ob
  INNER JOIN public.requests r ON r.id = ob.request_id
  INNER JOIN public.vendors v ON v.id = ob.vendor_id
  WHERE ob.payment_status = 'unpaid'
    AND ob.payment_mode = 'upi'
    AND ob.created_at < now() - interval '48 hours'
    AND r.service_mode = 'delivery'
    AND r.delivery_fulfillment_method = 'agent'
    AND r.delivery_payment_timing = 'prepaid'
    AND r.status NOT IN ('cancelled', 'done')
    AND COALESCE(r.payment_status, 'unpaid') NOT IN ('claimed', 'confirmed', 'disputed', 'void')
    AND (
      (
        p_user_phone IS NOT NULL
        AND btrim(p_user_phone) <> ''
        AND (
          ob.user_phone = btrim(p_user_phone)
          OR r.user_phone = btrim(p_user_phone)
          OR (
            p_device_id IS NOT NULL
            AND btrim(p_device_id) <> ''
            AND r.device_id IS NOT NULL
            AND r.device_id = btrim(p_device_id)
          )
        )
      )
      OR (
        (p_user_phone IS NULL OR btrim(p_user_phone) = '')
        AND p_device_id IS NOT NULL
        AND btrim(p_device_id) <> ''
        AND r.device_id IS NOT NULL
        AND r.device_id = btrim(p_device_id)
      )
    )
  ORDER BY ob.created_at ASC
  LIMIT 1;
$$;

-- ============================================================================
-- 3) vendor_cancel_order from-state gate
-- ============================================================================

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
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);
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
    AND r.status IN ('sent', 'seen', 'accepted')
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.requests r
      JOIN public.vendors v ON v.id = r.vendor_id
      WHERE r.id = p_request_id
        AND r.vendor_id = p_vendor_id
        AND v.phone = p_vendor_phone
        AND r.status NOT IN ('sent', 'seen', 'accepted')
    ) THEN
      RAISE EXCEPTION 'invalid_from_status';
    END IF;
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.order_bills
  SET payment_status = 'void'
  WHERE request_id = p_request_id
    AND payment_status <> 'paid';
END;
$$;

COMMENT ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) IS
  'Cancel order only from sent|seen|accepted. Soft hybrid + ban assert; voids unpaid bills.';

REVOKE ALL ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean)
  TO anon, authenticated, service_role;

-- ============================================================================
-- 4) Pause recurring on permanent spawn failure
-- ============================================================================

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
