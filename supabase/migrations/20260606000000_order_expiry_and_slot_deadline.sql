-- Order expiry automation: help (accept timeout), delivery (slot deadline), appointment (past slot).
-- Runs every 5 minutes via pg_cron.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS delivery_slot_deadline timestamptz;

ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS related_id uuid REFERENCES public.requests (id) ON DELETE SET NULL;

INSERT INTO public.app_config (key, value)
VALUES
  ('help_accept_timeout_minutes', '15'),
  ('appointment_accept_timeout_hours', '24')
ON CONFLICT (key) DO NOTHING;

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

  -- Delivery: expire when slot deadline has passed
  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'delivery'
      AND r.status = 'sent'
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
      AND r.status = 'sent'
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
  'Expires stale sent help/delivery/appointment requests and notifies customers (order_expired).';

SELECT cron.schedule(
  'expire-pending-orders',
  '*/5 * * * *',
  $$SELECT expire_pending_orders();$$
);
