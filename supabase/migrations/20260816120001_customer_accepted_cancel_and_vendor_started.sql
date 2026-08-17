-- Customer cancel on accepted orders (mode/slot gated); vendor "I've Started" timestamp.

-- ── 1) vendor_started_at on requests ────────────────────────────────────────

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS vendor_started_at timestamptz;

COMMENT ON COLUMN public.requests.vendor_started_at IS
  'Set when vendor notifies customer they have started (I''ve Started). Blocks Help customer cancel.';

-- ── 2) Delivery slot window start (mirrors ParchiSheet getDeliverySlotDeadline ends) ─

CREATE OR REPLACE FUNCTION public.delivery_slot_window_start(
  p_slot text,
  p_deadline timestamptz
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_slot IS NULL OR btrim(p_slot) = '' OR lower(btrim(p_slot)) = 'asap' THEN NULL
    WHEN lower(btrim(p_slot)) = 'tomorrow' THEN p_deadline - interval '20 hours'
    ELSE p_deadline - interval '4 hours'
  END;
$$;

COMMENT ON FUNCTION public.delivery_slot_window_start(text, timestamptz) IS
  'Window open time for a scheduled delivery slot. Morning/afternoon/evening: deadline − 4h; tomorrow: deadline − 20h (midnight); asap/null: NULL.';

-- ── 3) Vendor marks order started ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_vendor_order_started(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests
  SET vendor_started_at = COALESCE(vendor_started_at, now())
  WHERE id = p_request_id
    AND vendor_id = p_vendor_id
    AND status = 'accepted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.mark_vendor_order_started(uuid, uuid, text) IS
  'Vendor taps I''ve Started on an accepted order. Idempotent; first tap sets vendor_started_at.';

GRANT EXECUTE ON FUNCTION public.mark_vendor_order_started(uuid, uuid, text) TO anon, authenticated;

-- ── 4) cancel_customer_order: allow accepted with mode/slot gates ───────────

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
DECLARE
  v_row public.requests%ROWTYPE;
  v_mode text;
  v_start timestamptz;
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT *
  INTO v_row
  FROM public.requests
  WHERE id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_id)
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF v_row.status IN ('sent', 'seen') THEN
    UPDATE public.requests
    SET status = 'cancelled'
    WHERE id = p_request_id;
  ELSIF v_row.status = 'accepted' THEN
    IF v_row.appointment_time IS NOT NULL THEN
      RAISE EXCEPTION 'appointment_use_dismiss';
    END IF;

    v_mode := COALESCE(
      NULLIF(btrim(v_row.service_mode), ''),
      (SELECT v.service_mode FROM public.vendors v WHERE v.id = v_row.vendor_id)
    );

    IF lower(btrim(coalesce(v_mode, ''))) = 'help' THEN
      IF v_row.vendor_started_at IS NOT NULL THEN
        RAISE EXCEPTION 'cancel_blocked_vendor_started';
      END IF;
    ELSIF lower(btrim(coalesce(v_mode, ''))) = 'delivery' THEN
      IF lower(btrim(coalesce(v_row.delivery_slot, ''))) = 'asap' THEN
        RAISE EXCEPTION 'cancel_blocked_asap_accepted';
      ELSE
        v_start := public.delivery_slot_window_start(v_row.delivery_slot, v_row.delivery_slot_deadline);
        IF v_start IS NULL OR now() >= v_start THEN
          RAISE EXCEPTION 'cancel_blocked_window_started';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'cancel_blocked';
    END IF;

    UPDATE public.requests
    SET status = 'cancelled'
    WHERE id = p_request_id;
  ELSE
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.order_bills
  SET payment_status = 'void'
  WHERE request_id = p_request_id
    AND payment_status <> 'paid';
END;
$$;

COMMENT ON FUNCTION public.cancel_customer_order(uuid, text, text) IS
  'Customer cancels own order. sent/seen always allowed; accepted gated by service mode (help/delivery). Appointments use dismiss_order.';

GRANT EXECUTE ON FUNCTION public.cancel_customer_order(uuid, text, text) TO anon, authenticated;

-- ── 5) Expose vendor_started_at on get_my_orders for customer cancel gates ──

DROP FUNCTION IF EXISTS public.get_my_orders(text, text);

CREATE OR REPLACE FUNCTION public.get_my_orders(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  device_id text,
  vendor_id uuid,
  message text,
  status text,
  payment_status text,
  created_at timestamptz,
  updated_at timestamptz,
  user_phone text,
  appointment_time timestamptz,
  appointment_status text,
  cancel_reason text,
  delivery_slot text,
  delivery_slot_deadline timestamptz,
  delivery_address text,
  customer_latitude double precision,
  customer_longitude double precision,
  is_edited boolean,
  service_mode text,
  delivery_fulfillment_method text,
  delivery_payment_timing text,
  vendor_started_at timestamptz,
  vendor_shop_name text,
  vendor_service_mode text,
  vendor_phone text,
  vendor_latitude double precision,
  vendor_longitude double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_orders', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT
    r.id, r.device_id, r.vendor_id, r.message, r.status, r.payment_status,
    r.created_at, r.updated_at, r.user_phone, r.appointment_time,
    r.appointment_status, r.cancel_reason, r.delivery_slot,
    r.delivery_slot_deadline, r.delivery_address, r.customer_latitude,
    r.customer_longitude, r.is_edited,
    r.service_mode,
    r.delivery_fulfillment_method,
    r.delivery_payment_timing,
    r.vendor_started_at,
    v.shop_name,
    COALESCE(r.service_mode, v.service_mode) AS vendor_service_mode,
    v.phone, v.latitude, v.longitude
  FROM public.requests r
  LEFT JOIN public.vendors v ON v.id = r.vendor_id
  WHERE r.status <> 'done'
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN r.user_phone = btrim(p_user_phone)
        ELSE r.device_id = btrim(p_device_id)
      END
    )
  ORDER BY r.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_orders(text, text) IS
  'Customer order list with vendor fields, delivery payment snapshot, and vendor_started_at for cancel gates.';

REVOKE ALL ON FUNCTION public.get_my_orders(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_orders(text, text) TO anon, authenticated, service_role;
