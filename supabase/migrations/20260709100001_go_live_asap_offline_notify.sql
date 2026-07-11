-- Go-Live gates for ASAP delivery / instant appointment, vendor-offline notifications
-- via DB trigger (not only VendorMode manual toggle), and offline-at-order notices.

-- ── Request mode helpers (mirror VendorMode.tsx blocking / notify rules) ─────

CREATE OR REPLACE FUNCTION public._request_inferred_service_mode(
  p_delivery_slot text,
  p_appointment_time timestamptz
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_appointment_time IS NOT NULL THEN 'appointment'
    WHEN p_delivery_slot IS NOT NULL AND btrim(p_delivery_slot) <> '' THEN 'delivery'
    ELSE 'help'
  END;
$$;

CREATE OR REPLACE FUNCTION public._appointment_is_today(p_appointment_time timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_appointment_time IS NOT NULL
    AND (p_appointment_time AT TIME ZONE 'Asia/Kolkata')::date
      = (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

CREATE OR REPLACE FUNCTION public._order_blocks_going_offline(
  p_delivery_slot text,
  p_appointment_time timestamptz,
  p_service_mode text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_mode text := lower(btrim(coalesce(p_service_mode, 'help')));
BEGIN
  IF v_mode = 'help' THEN
    RETURN true;
  END IF;
  IF v_mode = 'delivery' THEN
    RETURN lower(btrim(coalesce(p_delivery_slot, ''))) <> 'tomorrow';
  END IF;
  IF v_mode = 'appointment' THEN
    RETURN public._appointment_is_today(p_appointment_time);
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public._order_should_notify_vendor_offline(
  p_status text,
  p_appointment_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_status = 'accepted'
    OR lower(btrim(coalesce(p_appointment_status, ''))) = 'confirmed';
$$;

CREATE OR REPLACE FUNCTION public._order_should_notify_pending_vendor_offline(
  p_status text,
  p_appointment_status text,
  p_delivery_slot text,
  p_appointment_time timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_mode text;
BEGIN
  IF p_status NOT IN ('sent', 'seen') THEN
    RETURN false;
  END IF;
  IF public._order_should_notify_vendor_offline(p_status, p_appointment_status) THEN
    RETURN false;
  END IF;
  v_mode := public._request_inferred_service_mode(p_delivery_slot, p_appointment_time);
  RETURN public._order_blocks_going_offline(p_delivery_slot, p_appointment_time, v_mode);
END;
$$;

-- ── Notify customers when vendor goes offline (any is_active flip to false) ──

CREATE OR REPLACE FUNCTION public.notify_vendor_offline_orders(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_active_title text := 'Your vendor has gone offline';
  v_active_body text :=
    'Your order may be affected. Please find another vendor if needed.';
  v_pending_title text := 'Vendor has gone offline';
  v_pending_body text :=
    'Your vendor has gone offline. You can cancel this order and place a new one, or wait for them to come back online.';
BEGIN
  FOR r IN
    SELECT
      id,
      user_phone,
      status,
      appointment_status,
      delivery_slot,
      appointment_time
    FROM public.requests
    WHERE vendor_id = p_vendor_id
      AND status IN ('sent', 'seen', 'accepted')
  LOOP
    IF r.user_phone IS NULL OR btrim(r.user_phone) = '' THEN
      CONTINUE;
    END IF;

    IF public._order_should_notify_vendor_offline(r.status, r.appointment_status) THEN
      INSERT INTO public.user_notifications (
        user_phone,
        type,
        title,
        body,
        route,
        route_params,
        related_id,
        is_informational,
        is_read
      )
      VALUES (
        r.user_phone,
        'order_update',
        v_active_title,
        v_active_body,
        'my-orders',
        jsonb_build_object('order_id', r.id),
        r.id,
        false,
        false
      );
    ELSIF public._order_should_notify_pending_vendor_offline(
      r.status,
      r.appointment_status,
      r.delivery_slot,
      r.appointment_time
    ) THEN
      INSERT INTO public.user_notifications (
        user_phone,
        type,
        title,
        body,
        route,
        route_params,
        related_id,
        is_informational,
        is_read
      )
      VALUES (
        r.user_phone,
        'order_update',
        v_pending_title,
        v_pending_body,
        'my-orders',
        jsonb_build_object('order_id', r.id),
        r.id,
        false,
        false
      );
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_vendors_is_active_offline_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.is_active IS DISTINCT FROM NEW.is_active
    AND NEW.is_active = false
  THEN
    PERFORM public.notify_vendor_offline_orders(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendors_is_active_offline_notify ON public.vendors;
CREATE TRIGGER vendors_is_active_offline_notify
  AFTER UPDATE OF is_active ON public.vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_vendors_is_active_offline_notify();

-- ── create_customer_request: Go-Live gates + offline-at-create notice ─────────

DROP FUNCTION IF EXISTS public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision
);

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
  p_appointment_instant boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_active boolean;
  v_pending_title text := 'Vendor has gone offline';
  v_pending_body text :=
    'Your vendor has gone offline. You can cancel this order and place a new one, or wait for them to come back online.';
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT v.is_active
  INTO v_vendor_active
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF lower(btrim(coalesce(p_delivery_slot, ''))) = 'asap' AND v_vendor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'vendor_not_live_for_asap';
  END IF;

  IF p_appointment_instant IS TRUE AND v_vendor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'vendor_not_live_for_instant';
  END IF;

  INSERT INTO public.requests (
    device_id,
    vendor_id,
    message,
    status,
    user_phone,
    device_id_log,
    delivery_address,
    delivery_slot,
    delivery_slot_deadline,
    appointment_time,
    appointment_status,
    customer_latitude,
    customer_longitude
  )
  VALUES (
    p_device_id,
    p_vendor_id,
    p_message,
    'sent',
    p_user_phone,
    p_device_id_log,
    p_delivery_address,
    p_delivery_slot,
    p_delivery_slot_deadline,
    p_appointment_time,
    p_appointment_status,
    p_customer_latitude,
    p_customer_longitude
  )
  RETURNING id INTO v_id;

  IF v_vendor_active IS NOT TRUE
    AND p_user_phone IS NOT NULL
    AND btrim(p_user_phone) <> ''
  THEN
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route,
      route_params,
      related_id,
      is_informational,
      is_read
    )
    VALUES (
      p_user_phone,
      'order_update',
      v_pending_title,
      v_pending_body,
      'my-orders',
      jsonb_build_object('order_id', v_id),
      v_id,
      false,
      false
    );
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean
) TO anon, authenticated;
