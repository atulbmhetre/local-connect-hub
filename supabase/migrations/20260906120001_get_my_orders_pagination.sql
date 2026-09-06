-- Bound get_my_orders (was unbounded). Optional p_limit + matching count RPC.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

DROP FUNCTION IF EXISTS public.get_my_orders(text, text);
DROP FUNCTION IF EXISTS public.get_my_orders(text, text, integer);

CREATE OR REPLACE FUNCTION public.get_my_orders(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_limit integer DEFAULT 50
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
  vendor_longitude double precision,
  category_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_limit integer;
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

  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));

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
    v.phone,
    CASE WHEN r.category_id IS NULL THEN NULL ELSE vc.latitude END,
    CASE WHEN r.category_id IS NULL THEN NULL ELSE vc.longitude END,
    r.category_id
  FROM public.requests r
  LEFT JOIN public.vendors v ON v.id = r.vendor_id
  LEFT JOIN public.vendor_categories vc
    ON vc.vendor_id = r.vendor_id
   AND vc.category_id = r.category_id
  WHERE r.status <> 'done'
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN r.user_phone = btrim(p_user_phone)
        ELSE r.device_id = btrim(p_device_id)
      END
    )
  ORDER BY r.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.get_my_orders(text, text, integer) IS
  'Customer order list (paginated): vendor GPS from request category pin. Null category_id → null GPS.';

REVOKE ALL ON FUNCTION public.get_my_orders(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_orders(text, text, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_my_orders_count(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_count bigint;
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

  IF NOT public.check_and_log_rate_limit('get_my_orders_count', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT count(*)::bigint INTO v_count
  FROM public.requests r
  WHERE r.status <> 'done'
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN r.user_phone = btrim(p_user_phone)
        ELSE r.device_id = btrim(p_device_id)
      END
    );

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.get_my_orders_count(text, text) IS
  'Exact non-done order count for the same identity filter as get_my_orders.';

REVOKE ALL ON FUNCTION public.get_my_orders_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_orders_count(text, text) TO anon, authenticated, service_role;
