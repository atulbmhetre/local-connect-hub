-- FCM push on order expiry via notify-user (PROD: rpxsyeqskvhjmbkxnpmd).
-- Push this migration only to the PROD Supabase project.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.expire_pending_orders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  help_accept_timeout_minutes integer;
  appointment_accept_timeout_hours integer;
  notify_url text := 'https://rpxsyeqskvhjmbkxnpmd.supabase.co/functions/v1/notify-user';
  notify_anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0';
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
$$;

COMMENT ON FUNCTION public.expire_pending_orders() IS
  'Near-deadline warnings, expires stale help/delivery/appointment requests, inbox + FCM (notify-user) per customer per run.';
