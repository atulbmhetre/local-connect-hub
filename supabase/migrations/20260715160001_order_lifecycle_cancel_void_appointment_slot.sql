-- Order lifecycle: void unpaid bills on cancel; prevent appointment double-booking.

-- ── 1) Cancel RPCs void unpaid bills (leave paid untouched) ─────────────────

CREATE OR REPLACE FUNCTION public.cancel_customer_order(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.requests
  SET status = 'cancelled'
  WHERE id = p_request_id
    AND status IN ('sent', 'seen')
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.order_bills
  SET payment_status = 'void'
  WHERE request_id = p_request_id
    AND payment_status <> 'paid';
END;
$$;

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
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.order_bills
  SET payment_status = 'void'
  WHERE request_id = p_request_id
    AND payment_status <> 'paid';
END;
$$;

-- ── 2) Appointment double-booking: one active slot per vendor+timestamp ─────
-- Declined bookings keep status='seen'; also exclude appointment_status so a
-- decline frees the slot (status-only filter would leave them blocking forever).

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY vendor_id, appointment_time
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM public.requests
  WHERE appointment_time IS NOT NULL
    AND status NOT IN ('cancelled', 'declined')
    AND COALESCE(appointment_status, '') NOT IN ('declined', 'cancelled')
)
UPDATE public.requests r
SET
  status = 'cancelled',
  appointment_status = CASE
    WHEN r.appointment_status IS NULL OR r.appointment_status = 'pending'
      THEN 'cancelled'
    ELSE r.appointment_status
  END,
  cancel_reason = COALESCE(r.cancel_reason, 'duplicate_appointment_slot_cleanup')
FROM ranked
WHERE r.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS requests_vendor_appointment_slot_uidx
  ON public.requests (vendor_id, appointment_time)
  WHERE appointment_time IS NOT NULL
    AND status NOT IN ('cancelled', 'declined')
    AND COALESCE(appointment_status, '') NOT IN ('declined', 'cancelled');

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
  p_appointment_instant boolean DEFAULT false,
  p_category_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_active boolean;
  v_category_id uuid;
  v_pending_title text := 'Vendor has gone offline';
  v_pending_body text :=
    'Your vendor has gone offline. You can cancel this order and place a new one, or wait for them to come back online.';
  v_constraint text;
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

  IF p_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
      AND vc.status = 'approved'
  ) THEN
    v_category_id := p_category_id;
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      SELECT c.id
      INTO v_category_id
      FROM public.vendors v
      JOIN public.categories c ON c.label = v.category
      WHERE v.id = p_vendor_id
      LIMIT 1;
    END IF;
  END IF;

  BEGIN
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
      customer_longitude,
      category_id
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
      p_customer_longitude,
      v_category_id
    )
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'requests_vendor_appointment_slot_uidx'
        OR SQLERRM ILIKE '%requests_vendor_appointment_slot_uidx%'
      THEN
        RAISE EXCEPTION 'appointment_slot_taken';
      END IF;
      RAISE;
  END;

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
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid
) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cancel_customer_order(uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) TO anon, authenticated;
