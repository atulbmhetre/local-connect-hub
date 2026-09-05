/**
 * Client idempotency for create_recurring_order (lost-response + retry).
 * Parent recurring_orders + first child request share the same client key.
 * TEST project-ref at write time: hhdylnhqdzfabsolwxdz
 */

ALTER TABLE public.recurring_orders
  ADD COLUMN IF NOT EXISTS client_idempotency_key text;

COMMENT ON COLUMN public.recurring_orders.client_idempotency_key IS
  'Optional client UUID per recurring-placement attempt; dedupes lost-response retries.';

CREATE UNIQUE INDEX IF NOT EXISTS recurring_orders_client_idempotency_key_uidx
  ON public.recurring_orders (client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;

DROP FUNCTION IF EXISTS public.create_recurring_order(
  text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, text,
  double precision, double precision, boolean, uuid, text, jsonb, text, integer
);

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
  p_interval_days integer DEFAULT NULL,
  p_client_idempotency_key text DEFAULT NULL
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
  v_idem text;
  v_phone text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  v_idem := NULLIF(btrim(COALESCE(p_client_idempotency_key, '')), '');

  IF v_idem IS NOT NULL THEN
    SELECT ro.id, ro.last_request_id
    INTO v_parent_id, v_request_id
    FROM public.recurring_orders ro
    WHERE ro.client_idempotency_key = v_idem
      AND ro.created_at > now() - interval '2 minutes'
      AND (
        CASE
          WHEN v_phone IS NOT NULL THEN ro.user_phone = v_phone
          ELSE ro.device_id = p_device_id
        END
      )
    ORDER BY ro.created_at DESC
    LIMIT 1;

    IF v_parent_id IS NOT NULL THEN
      IF v_request_id IS NOT NULL THEN
        RETURN v_request_id;
      END IF;

      -- Parent without linked child (partial prior attempt): finish or reuse request by key.
      SELECT r.id
      INTO v_request_id
      FROM public.requests r
      WHERE r.client_idempotency_key = v_idem
      LIMIT 1;

      IF v_request_id IS NULL THEN
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
          p_service_location,
          v_idem
        );
      END IF;

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
    END IF;
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

  BEGIN
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
      next_run_at,
      client_idempotency_key
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
      now() + make_interval(days => v_days),
      v_idem
    )
    RETURNING id INTO v_parent_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF v_idem IS NULL THEN
        RAISE;
      END IF;
      SELECT ro.id, ro.last_request_id
      INTO v_parent_id, v_request_id
      FROM public.recurring_orders ro
      WHERE ro.client_idempotency_key = v_idem
      LIMIT 1;
      IF v_parent_id IS NULL THEN
        RAISE;
      END IF;
      IF v_request_id IS NOT NULL THEN
        RETURN v_request_id;
      END IF;
      SELECT r.id
      INTO v_request_id
      FROM public.requests r
      WHERE r.client_idempotency_key = v_idem
      LIMIT 1;
      IF v_request_id IS NULL THEN
        RAISE;
      END IF;
      RETURN v_request_id;
  END;

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
      p_service_location,
      v_idem
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
  double precision, double precision, boolean, uuid, text, jsonb, text, integer, text
) IS
  'Booking-time recurring arrangement: parent + first request. Optional p_client_idempotency_key dedupes lost-response retries (parent + child).';

REVOKE ALL ON FUNCTION public.create_recurring_order(
  text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, text,
  double precision, double precision, boolean, uuid, text, jsonb, text, integer, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_recurring_order(
  text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, text,
  double precision, double precision, boolean, uuid, text, jsonb, text, integer, text
) TO anon, authenticated, service_role;
