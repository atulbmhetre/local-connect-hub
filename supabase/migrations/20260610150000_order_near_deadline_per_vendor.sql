-- One near-deadline warning per customer per vendor (not per order).

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
    'Appointment soon',
    'Your vendor has not seen your booking yet. The appointment time is approaching.',
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
    'order_near_deadline_unconfirmed',
    'Appointment soon',
    'Your vendor has not confirmed your booking. The appointment time is approaching.',
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
