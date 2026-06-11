-- Near-deadline customer warnings (inbox via expire_pending_orders cron; push via warn-near-deadline edge function).
-- Thresholds are configurable in app_config (not exposed in admin UI).

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS near_deadline_warned_at timestamptz;

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS near_deadline_push_sent boolean NOT NULL DEFAULT false;

INSERT INTO public.app_config (key, value)
VALUES
  ('delivery_near_deadline_minutes', '60'),
  ('appointment_near_deadline_minutes', '60'),
  ('help_near_deadline_minutes', '5')
ON CONFLICT (key) DO NOTHING;

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
  WITH warned AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'delivery'
      AND r.status = 'sent'
      AND r.near_deadline_warned_at IS NULL
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
    RETURNING r.id, r.user_phone
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
    w.user_phone,
    'order_near_deadline_unseen',
    'Delivery window soon',
    'Your vendor has not seen your order yet. The delivery window is approaching.',
    'my-orders',
    jsonb_build_object('order_id', w.id),
    w.id,
    false
  FROM warned w;

  -- Delivery: vendor saw but has not accepted (seen)
  WITH warned AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'delivery'
      AND r.status = 'seen'
      AND r.near_deadline_warned_at IS NULL
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
    RETURNING r.id, r.user_phone
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
    w.user_phone,
    'order_near_deadline_unconfirmed',
    'Delivery window soon',
    'Your vendor saw your order but has not accepted it. The delivery window is approaching.',
    'my-orders',
    jsonb_build_object('order_id', w.id),
    w.id,
    false
  FROM warned w;

  -- Appointment / booking: vendor has not opened the request (sent + pending)
  WITH warned AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'appointment'
      AND r.status = 'sent'
      AND r.appointment_status = 'pending'
      AND r.near_deadline_warned_at IS NULL
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
    RETURNING r.id, r.user_phone
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
    w.user_phone,
    'order_near_deadline_unseen',
    'Appointment soon',
    'Your vendor has not seen your booking yet. The appointment time is approaching.',
    'my-orders',
    jsonb_build_object('order_id', w.id),
    w.id,
    false
  FROM warned w;

  -- Appointment / booking: vendor saw but has not confirmed (seen + pending)
  WITH warned AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'appointment'
      AND r.status = 'seen'
      AND r.appointment_status = 'pending'
      AND r.near_deadline_warned_at IS NULL
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
    RETURNING r.id, r.user_phone
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
    w.user_phone,
    'order_near_deadline_unconfirmed',
    'Appointment soon',
    'Your vendor has not confirmed your booking. The appointment time is approaching.',
    'my-orders',
    jsonb_build_object('order_id', w.id),
    w.id,
    false
  FROM warned w;

  -- Help: vendor has not accepted before the accept timeout
  WITH warned AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'help'
      AND r.status = 'sent'
      AND r.near_deadline_warned_at IS NULL
      AND now() >= r.created_at
        + (help_accept_timeout_minutes || ' minutes')::interval
        - (help_near_deadline_minutes || ' minutes')::interval
      AND now() < r.created_at + (help_accept_timeout_minutes || ' minutes')::interval
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
    RETURNING r.id, r.user_phone
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
    w.user_phone,
    'order_near_deadline_unseen',
    'Order response needed',
    'Your vendor has not accepted your order yet. Time is running out.',
    'my-orders',
    jsonb_build_object('order_id', w.id),
    w.id,
    false
  FROM warned w;
END;
$$;

COMMENT ON FUNCTION public.warn_pending_orders_near_deadline() IS
  'Warns customers when a vendor has not committed and the expected time is near (inbox row; push via warn-near-deadline edge function).';

CREATE OR REPLACE FUNCTION public.expire_pending_orders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  help_accept_timeout_minutes integer;
  appointment_accept_timeout_hours integer;
BEGIN
  PERFORM public.warn_pending_orders_near_deadline();

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
  )
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
    'Order Expired',
    'No vendor accepted your request in time. Please try again.',
    jsonb_build_object('order_id', e.id),
    e.id,
    false
  FROM expired e
  WHERE e.user_phone IS NOT NULL
    AND trim(e.user_phone) <> '';

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
  )
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
    'Order Expired',
    'No vendor accepted your request in time. Please try again.',
    jsonb_build_object('order_id', e.id),
    e.id,
    false
  FROM expired e
  WHERE e.user_phone IS NOT NULL
    AND trim(e.user_phone) <> '';

  -- Appointment: expire when appointment time has passed while still pending vendor confirmation
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
    RETURNING r.id, r.user_phone
  )
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
    'Order Expired',
    'No vendor accepted your request in time. Please try again.',
    jsonb_build_object('order_id', e.id),
    e.id,
    false
  FROM expired e
  WHERE e.user_phone IS NOT NULL
    AND trim(e.user_phone) <> '';
END;
$$;

COMMENT ON FUNCTION public.expire_pending_orders() IS
  'Near-deadline warnings, then expires stale help/delivery/appointment requests and notifies customers (order_expired).';
