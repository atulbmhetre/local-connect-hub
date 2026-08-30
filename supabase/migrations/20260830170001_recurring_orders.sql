-- Recurring orders are a booking-time choice (Delivery / Scheduled only), not a
-- vendor registration setting. A requests row is one finite order (sent → done /
-- expired / cancelled). Recurrence outlives any instance, so it lives on a
-- lightweight parent (recurring_orders) that spawns normal requests over time.
-- Khata/ledger is unchanged: each spawned request is a normal line item.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS recurring_order_id uuid NULL;

CREATE TABLE IF NOT EXISTS public.recurring_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  user_phone text NULL,
  device_id text NULL,
  category_id uuid NULL REFERENCES public.categories (id) ON DELETE SET NULL,
  service_mode text NOT NULL CHECK (service_mode IN ('delivery', 'appointment')),
  interval_kind text NOT NULL CHECK (interval_kind IN ('daily', 'weekly', 'custom')),
  interval_days integer NOT NULL CHECK (interval_days >= 1 AND interval_days <= 30),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'cancelled')),
  message text NULL,
  items jsonb NULL,
  delivery_address text NULL,
  delivery_slot text NULL,
  delivery_slot_deadline_tod time NULL,
  appointment_tod time NULL,
  appointment_status text NULL,
  service_location text NULL,
  customer_latitude double precision NULL,
  customer_longitude double precision NULL,
  next_run_at timestamptz NOT NULL,
  last_spawned_at timestamptz NULL,
  last_request_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_orders_identity_chk CHECK (
    user_phone IS NOT NULL OR device_id IS NOT NULL
  )
);

COMMENT ON TABLE public.recurring_orders IS
  'Standing Delivery/Scheduled arrangement. Spawns ordinary requests rows; pause/cancel live here, not on a single order.';

CREATE INDEX IF NOT EXISTS recurring_orders_due_idx
  ON public.recurring_orders (next_run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS recurring_orders_customer_phone_idx
  ON public.recurring_orders (user_phone)
  WHERE user_phone IS NOT NULL AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS recurring_orders_customer_device_idx
  ON public.recurring_orders (device_id)
  WHERE device_id IS NOT NULL AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS requests_recurring_order_id_idx
  ON public.requests (recurring_order_id)
  WHERE recurring_order_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'requests_recurring_order_id_fkey'
      AND conrelid = 'public.requests'::regclass
  ) THEN
    ALTER TABLE public.requests
      ADD CONSTRAINT requests_recurring_order_id_fkey
      FOREIGN KEY (recurring_order_id)
      REFERENCES public.recurring_orders (id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.recurring_orders ENABLE ROW LEVEL SECURITY;

-- RPC-only. Direct table access is not part of the customer/vendor UI.

CREATE OR REPLACE FUNCTION public._recurring_interval_days(p_kind text, p_days integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_kind = 'daily' THEN
    RETURN 1;
  END IF;
  IF p_kind = 'weekly' THEN
    RETURN 7;
  END IF;
  IF p_kind = 'custom' THEN
    IF p_days IS NULL OR p_days < 2 OR p_days > 30 THEN
      RAISE EXCEPTION 'invalid_recurrence_interval';
    END IF;
    RETURN p_days;
  END IF;
  RAISE EXCEPTION 'invalid_recurrence';
END;
$$;

REVOKE ALL ON FUNCTION public._recurring_interval_days(text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._delivery_slot_deadline_on(p_slot text, p_day date)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_slot
    WHEN 'morning' THEN (p_day + time '12:00') AT TIME ZONE 'Asia/Kolkata'
    WHEN 'afternoon' THEN (p_day + time '16:00') AT TIME ZONE 'Asia/Kolkata'
    WHEN 'evening' THEN (p_day + time '20:00') AT TIME ZONE 'Asia/Kolkata'
    ELSE (p_day + time '20:00') AT TIME ZONE 'Asia/Kolkata'
  END;
$$;

REVOKE ALL ON FUNCTION public._delivery_slot_deadline_on(text, date) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._advance_recurring_next_run(p_from timestamptz, p_days integer)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_next timestamptz;
BEGIN
  v_next := p_from + make_interval(days => p_days);
  WHILE v_next <= now() LOOP
    v_next := v_next + make_interval(days => p_days);
  END LOOP;
  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public._advance_recurring_next_run(timestamptz, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.create_recurring_order(
  p_device_id text,
  p_vendor_id uuid,
  p_message text,
  p_interval_kind text,
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
  p_interval_days integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer;
  v_mode text;
  v_parent_id uuid;
  v_request_id uuid;
  v_slot text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_days := public._recurring_interval_days(p_interval_kind, p_interval_days);
  v_mode := lower(btrim(COALESCE(p_service_mode, '')));

  IF v_mode IS NULL OR v_mode NOT IN ('delivery', 'appointment') THEN
    RAISE EXCEPTION 'recurrence_mode_not_allowed';
  END IF;
  IF COALESCE(p_appointment_instant, false) THEN
    RAISE EXCEPTION 'recurrence_mode_not_allowed';
  END IF;

  IF v_mode = 'delivery' THEN
    v_slot := lower(btrim(COALESCE(p_delivery_slot, '')));
    IF v_slot IS NULL OR v_slot IN ('', 'asap', 'tomorrow') THEN
      RAISE EXCEPTION 'recurrence_slot_not_allowed';
    END IF;
  END IF;

  IF v_mode = 'appointment' AND p_appointment_time IS NULL THEN
    RAISE EXCEPTION 'recurrence_needs_schedule';
  END IF;

  INSERT INTO public.recurring_orders (
    vendor_id,
    user_phone,
    device_id,
    category_id,
    service_mode,
    interval_kind,
    interval_days,
    status,
    message,
    items,
    delivery_address,
    delivery_slot,
    appointment_tod,
    appointment_status,
    service_location,
    customer_latitude,
    customer_longitude,
    next_run_at
  )
  VALUES (
    p_vendor_id,
    NULLIF(btrim(p_user_phone), ''),
    NULLIF(btrim(p_device_id), ''),
    p_category_id,
    v_mode,
    p_interval_kind,
    v_days,
    'active',
    p_message,
    p_items,
    p_delivery_address,
    CASE WHEN v_mode = 'delivery' THEN v_slot ELSE NULL END,
    CASE WHEN v_mode = 'appointment' THEN (p_appointment_time AT TIME ZONE 'Asia/Kolkata')::time ELSE NULL END,
    p_appointment_status,
    p_service_location,
    p_customer_latitude,
    p_customer_longitude,
    now() + make_interval(days => v_days)
  )
  RETURNING id INTO v_parent_id;

  BEGIN
    v_request_id := public.create_customer_request(
      p_device_id,
      p_vendor_id,
      p_message,
      p_user_phone,
      p_device_id_log,
      p_delivery_address,
      p_delivery_slot,
      p_delivery_slot_deadline,
      p_appointment_time,
      p_appointment_status,
      p_customer_latitude,
      p_customer_longitude,
      p_appointment_instant,
      p_category_id,
      p_service_mode,
      p_items,
      p_service_location
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.recurring_orders WHERE id = v_parent_id;
    RAISE;
  END;

  UPDATE public.requests
  SET recurring_order_id = v_parent_id
  WHERE id = v_request_id;

  UPDATE public.recurring_orders
  SET
    last_request_id = v_request_id,
    last_spawned_at = now(),
    category_id = COALESCE(
      (SELECT r.category_id FROM public.requests r WHERE r.id = v_request_id),
      category_id
    ),
    updated_at = now()
  WHERE id = v_parent_id;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.create_recurring_order(
  text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, text,
  double precision, double precision, boolean, uuid, text, jsonb, text, integer
) IS
  'Booking-time recurring arrangement: parent row + first ordinary request. Help/ASAP/instant are rejected.';

REVOKE ALL ON FUNCTION public.create_recurring_order(
  text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, text,
  double precision, double precision, boolean, uuid, text, jsonb, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_recurring_order(
  text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, text,
  double precision, double precision, boolean, uuid, text, jsonb, text, integer
) TO anon, authenticated, service_role;

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
      UPDATE public.recurring_orders
      SET
        next_run_at = public._advance_recurring_next_run(next_run_at, interval_days),
        updated_at = now()
      WHERE id = rec.id;
    END;
  END LOOP;

  RETURN v_spawned;
END;
$$;

COMMENT ON FUNCTION public.spawn_due_recurring_orders() IS
  'Cron + tests: create the next ordinary request for each due active recurring arrangement.';

REVOKE ALL ON FUNCTION public.spawn_due_recurring_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spawn_due_recurring_orders() TO service_role;

CREATE OR REPLACE FUNCTION public.list_my_recurring_orders(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  vendor_id uuid,
  shop_name text,
  category_label text,
  service_mode text,
  interval_kind text,
  interval_days integer,
  status text,
  delivery_slot text,
  next_run_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  RETURN QUERY
  SELECT
    ro.id,
    ro.vendor_id,
    v.shop_name,
    c.label,
    ro.service_mode,
    ro.interval_kind,
    ro.interval_days,
    ro.status,
    ro.delivery_slot,
    ro.next_run_at,
    ro.created_at
  FROM public.recurring_orders ro
  JOIN public.vendors v ON v.id = ro.vendor_id
  LEFT JOIN public.categories c ON c.id = ro.category_id
  WHERE ro.status IN ('active', 'paused')
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN ro.user_phone = btrim(p_user_phone)
        ELSE ro.device_id = btrim(p_device_id)
      END
    )
  ORDER BY ro.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_my_recurring_orders(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_recurring_orders(text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.customer_set_recurring_order_status(
  p_recurring_order_id uuid,
  p_status text,
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_owner uuid;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_status := lower(btrim(p_status));
  IF v_status NOT IN ('paused', 'active', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_recurring_status';
  END IF;

  SELECT ro.id
  INTO v_owner
  FROM public.recurring_orders ro
  WHERE ro.id = p_recurring_order_id
    AND ro.status IN ('active', 'paused')
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN ro.user_phone = btrim(p_user_phone)
        ELSE ro.device_id = btrim(p_device_id)
      END
    );

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'recurring_order_not_found';
  END IF;

  IF v_status = 'active' THEN
    UPDATE public.recurring_orders
    SET
      status = 'active',
      next_run_at = CASE
        WHEN next_run_at < now() THEN public._advance_recurring_next_run(now(), interval_days)
        ELSE next_run_at
      END,
      updated_at = now()
    WHERE id = p_recurring_order_id;
  ELSE
    UPDATE public.recurring_orders
    SET status = v_status, updated_at = now()
    WHERE id = p_recurring_order_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_set_recurring_order_status(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_set_recurring_order_status(uuid, text, text, text)
  TO anon, authenticated, service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'spawn-due-recurring-orders';

SELECT cron.schedule(
  'spawn-due-recurring-orders',
  '*/15 * * * *',
  $$SELECT public.spawn_due_recurring_orders();$$
);
