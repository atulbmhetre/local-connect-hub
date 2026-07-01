-- Restore slot/datetime-specific expiry copy and per-customer dedup lost in initial 000006 deploy.

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
  expired_title text := 'Order Expired';
  expired_body text := 'No vendor accepted your request in time. Please try again.';
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

  CREATE TEMP TABLE IF NOT EXISTS _expired_for_notify (
    request_id uuid PRIMARY KEY,
    user_phone text NOT NULL,
    notify_body text NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE _expired_for_notify;

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
      AND r.status = 'sent'
      AND r.created_at + (help_accept_timeout_minutes || ' minutes')::interval < now()
    RETURNING r.id, r.user_phone
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, notify_body)
  SELECT e.id, trim(e.user_phone), expired_body
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
  INSERT INTO _expired_for_notify (request_id, user_phone, notify_body)
  SELECT
    e.id,
    trim(e.user_phone),
    'No vendor accepted your request for the '
      || CASE COALESCE(e.delivery_slot, '')
        WHEN 'morning' THEN 'morning slot'
        WHEN 'evening' THEN 'evening slot'
        WHEN 'night' THEN 'night slot'
        ELSE 'your delivery slot'
      END
      || ' in time. Please try again.'
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
  INSERT INTO _expired_for_notify (request_id, user_phone, notify_body)
  SELECT
    e.id,
    trim(e.user_phone),
    'Your vendor did not confirm your booking'
      || CASE
        WHEN e.appointment_time IS NOT NULL THEN
          ' for ' || TO_CHAR(e.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM')
        ELSE ''
      END
      || ' in time.'
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH reps AS (
    SELECT DISTINCT ON (user_phone)
      request_id,
      user_phone,
      notify_body
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
      expired_title,
      r.notify_body,
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
      notify_body
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
        'title', expired_title,
        'body', rec.notify_body,
        'type', 'order_expired',
        'route', 'my-orders'
      )
    );
  END LOOP;
END;
$expire$;
