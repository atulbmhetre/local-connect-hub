-- Booking near-deadline copy (Gap B2 + B16) and appointment expiry copy (Gap B6).

CREATE OR REPLACE FUNCTION public.warn_pending_orders_near_deadline()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  help_accept_timeout_minutes integer;
  delivery_near_deadline_minutes integer;
  appointment_near_deadline_minutes integer;
  help_near_deadline_minutes integer;
BEGIN
  SELECT NULLIF(trim(value), '')::integer
  INTO help_accept_timeout_minutes
  FROM public.app_config
  WHERE key = 'help_accept_timeout_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO delivery_near_deadline_minutes
  FROM public.app_config
  WHERE key = 'delivery_near_deadline_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO appointment_near_deadline_minutes
  FROM public.app_config
  WHERE key = 'appointment_near_deadline_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO help_near_deadline_minutes
  FROM public.app_config
  WHERE key = 'help_near_deadline_minutes';

  IF help_accept_timeout_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key help_accept_timeout_minutes is missing or invalid';
  END IF;

  IF delivery_near_deadline_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key delivery_near_deadline_minutes is missing or invalid';
  END IF;

  IF appointment_near_deadline_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key appointment_near_deadline_minutes is missing or invalid';
  END IF;

  IF help_near_deadline_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key help_near_deadline_minutes is missing or invalid';
  END IF;

  -- Delivery: vendor has not opened the order (sent)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'delivery'
      AND r.status = 'sent'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'delivery'
      AND r.status = 'sent'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
    RETURNING r.id, r.user_phone, r.vendor_id, r.delivery_slot
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      delivery_slot
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
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
    rep.user_phone,
    'order_near_deadline_unseen',
    'Delivery window soon',
    'Your vendor has not seen your ' || COALESCE(rep.delivery_slot, 'delivery') || ' order yet. The delivery window is closing soon.',
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Delivery: vendor saw but has not accepted (seen)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'delivery'
      AND r.status = 'seen'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'delivery'
      AND r.status = 'seen'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
    RETURNING r.id, r.user_phone, r.vendor_id, r.delivery_slot
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      delivery_slot
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
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
    rep.user_phone,
    'order_near_deadline_unconfirmed',
    'Delivery window soon',
    'Your vendor saw your ' || COALESCE(rep.delivery_slot, 'delivery') || ' order but has not accepted it. The delivery window is closing soon.',
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Appointment / booking: vendor has not opened the request (sent + pending)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'appointment'
      AND r.status = 'sent'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'appointment'
      AND r.status = 'sent'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
    RETURNING r.id, r.user_phone, r.vendor_id, r.appointment_time
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      appointment_time
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
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
    rep.user_phone,
    'order_near_deadline_unseen',
    'Appointment reminder',
    'Your vendor has not seen your booking for ' || COALESCE(TO_CHAR(rep.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'), 'your appointment') || ' yet. Appointment time is approaching.',
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Appointment / booking: vendor saw but has not confirmed (seen + pending)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'appointment'
      AND r.status = 'seen'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'appointment'
      AND r.status = 'seen'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
    RETURNING r.id, r.user_phone, r.vendor_id, r.appointment_time
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      appointment_time
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
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
    rep.user_phone,
    'order_near_deadline_unconfirmed',
    'Appointment reminder',
    'Your vendor has not confirmed your booking for ' || COALESCE(TO_CHAR(rep.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'), 'your appointment') || '. Appointment time is approaching.',
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Help: vendor has not accepted before the accept timeout
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'help'
      AND r.status = 'sent'
      AND now() >= r.created_at
        + (help_accept_timeout_minutes || ' minutes')::interval
        - (help_near_deadline_minutes || ' minutes')::interval
      AND now() < r.created_at + (help_accept_timeout_minutes || ' minutes')::interval
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'help'
      AND r.status = 'sent'
      AND now() >= r.created_at
        + (help_accept_timeout_minutes || ' minutes')::interval
        - (help_near_deadline_minutes || ' minutes')::interval
      AND now() < r.created_at + (help_accept_timeout_minutes || ' minutes')::interval
    RETURNING r.id, r.user_phone, r.vendor_id
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
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
    rep.user_phone,
    'order_near_deadline_unseen',
    'Order response needed',
    'Your vendor has not accepted your order yet. Time is running out.',
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;
END;
$$;

COMMENT ON FUNCTION public.warn_pending_orders_near_deadline() IS
  'Warns customers once per vendor when expected time is near and the vendor has not committed (inbox; push via warn-near-deadline edge function).';

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $migrate$
DECLARE
  v_notify_url text;
  v_notify_anon_key text;
BEGIN
  SELECT
    (regexp_match(pg_get_functiondef(p.oid), 'notify_url text := ''([^'']+)'''))[1],
    (regexp_match(pg_get_functiondef(p.oid), 'notify_anon_key text := ''([^'']+)'''))[1]
  INTO v_notify_url, v_notify_anon_key
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'expire_pending_orders';

  IF v_notify_url IS NULL OR v_notify_anon_key IS NULL THEN
    RAISE EXCEPTION 'expire_pending_orders must already be FCM-enabled (apply _held expire migration first)';
  END IF;

  EXECUTE format($func$
CREATE OR REPLACE FUNCTION public.expire_pending_orders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $expire$
DECLARE
  help_accept_timeout_minutes integer;
  appointment_accept_timeout_hours integer;
  notify_url text := %L;
  notify_anon_key text := %L;
  expired_title text := 'Order Expired';
  expired_body text := 'No vendor accepted your request in time. Please try again.';
  rec record;
BEGIN
  PERFORM public.warn_pending_orders_near_deadline();

  CREATE TEMP TABLE IF NOT EXISTS _expire_push_phones (
    user_phone text PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE _expire_push_phones;

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

  -- Help: vendor must accept within configured minutes
  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'help'
      AND r.status = 'sent'
      AND r.created_at + (help_accept_timeout_minutes || ' minutes')::interval < now()
    RETURNING r.id, r.user_phone
  ),
  inserted AS (
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route_params,
      related_id,
      is_informational
    )
    SELECT
      e.user_phone,
      'order_expired',
      expired_title,
      expired_body,
      jsonb_build_object('order_id', e.id),
      e.id,
      false
    FROM expired e
    WHERE e.user_phone IS NOT NULL
      AND trim(e.user_phone) <> ''
    RETURNING user_phone
  )
  INSERT INTO _expire_push_phones (user_phone)
  SELECT DISTINCT trim(user_phone)
  FROM inserted
  ON CONFLICT (user_phone) DO NOTHING;

  -- Delivery: expire when slot deadline has passed (sent or seen, not accepted)
  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'delivery'
      AND r.status IN ('sent', 'seen')
      AND r.delivery_slot_deadline IS NOT NULL
      AND r.delivery_slot_deadline < now()
    RETURNING r.id, r.user_phone
  ),
  inserted AS (
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route_params,
      related_id,
      is_informational
    )
    SELECT
      e.user_phone,
      'order_expired',
      expired_title,
      expired_body,
      jsonb_build_object('order_id', e.id),
      e.id,
      false
    FROM expired e
    WHERE e.user_phone IS NOT NULL
      AND trim(e.user_phone) <> ''
    RETURNING user_phone
  )
  INSERT INTO _expire_push_phones (user_phone)
  SELECT DISTINCT trim(user_phone)
  FROM inserted
  ON CONFLICT (user_phone) DO NOTHING;

  -- Appointment: expire when appointment time has passed while still pending
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
  ),
  inserted AS (
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route_params,
      related_id,
      is_informational
    )
    SELECT
      e.user_phone,
      'order_expired',
      expired_title,
      'Your vendor did not confirm your booking' || CASE WHEN e.appointment_time IS NOT NULL THEN ' for ' || TO_CHAR(e.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') ELSE '' END || ' in time.',
      jsonb_build_object('order_id', e.id),
      e.id,
      false
    FROM expired e
    WHERE e.user_phone IS NOT NULL
      AND trim(e.user_phone) <> ''
    RETURNING user_phone
  )
  INSERT INTO _expire_push_phones (user_phone)
  SELECT DISTINCT trim(user_phone)
  FROM inserted
  ON CONFLICT (user_phone) DO NOTHING;

  FOR rec IN SELECT user_phone FROM _expire_push_phones LOOP
    PERFORM net.http_post(
      url := notify_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || notify_anon_key
      ),
      body := jsonb_build_object(
        'user_phone', rec.user_phone,
        'title', expired_title,
        'body', expired_body
      )
    );
  END LOOP;
END;
$expire$;

COMMENT ON FUNCTION public.expire_pending_orders() IS
  'Near-deadline warnings, expires stale help/delivery/appointment requests, inbox + FCM (notify-user) per customer per run.';
$func$, v_notify_url, v_notify_anon_key);
END;
$migrate$;
