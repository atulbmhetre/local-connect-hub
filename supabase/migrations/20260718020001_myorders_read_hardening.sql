-- MyOrders read hardening (OTP-off identity model).
--
-- Confirmed live on PROD (2026-07-18): a real customer with 4 non-done orders gets
-- ZERO rows from requests / order_bills / khata_ledger when reading with the anon
-- key and no Supabase Auth session (auth_user_phone() → NULL under every RLS
-- policy). MyOrders has therefore been silently empty for real OTP-off customers.
-- Same class of bug as saved_vendors (fixed in 20260718000001) and vendor restore
-- (fixed in 20260718010001).
--
-- This migration adds SECURITY DEFINER read RPCs with caller-supplied phone/device
-- identity, mirroring MyOrders' existing query filters exactly:
--   1) get_my_orders(p_user_phone, p_device_id)         — non-done request rows + vendor fields
--   2) get_my_order_bills(p_user_phone, p_device_id, p_request_ids)
--        — non-void bills for the caller's own requests, with items + edited flag
--        (order_items and bill_edit_audit customer reads are blocked by the same
--        RLS shape, so they are folded in here instead of two more broken queries)
--   3) get_my_khata_ledger(p_user_phone)                — khata strip (phone-scoped only;
--        khata_ledger has no device_id column, device-only users have no khata)
--   4) get_my_khata_transactions(p_user_phone, p_vendor_id) — khata detail view,
--        blocked by the same policy shape (khata_transactions_customer)
-- All rate-limited via check_and_log_rate_limit (30/min per identity), consistent
-- with tonight's saved-vendors pattern. RLS stays restrictive — no USING(true).

-- ── 1. get_my_orders ──────────────────────────────────────────────────────────

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

  -- Mirror MyOrders' scoping: phone-scoped when a phone is present, else device.
  RETURN QUERY
  SELECT
    r.id, r.device_id, r.vendor_id, r.message, r.status, r.payment_status,
    r.created_at, r.updated_at, r.user_phone, r.appointment_time,
    r.appointment_status, r.cancel_reason, r.delivery_slot,
    r.delivery_slot_deadline, r.delivery_address, r.customer_latitude,
    r.customer_longitude, r.is_edited,
    v.shop_name, v.service_mode, v.phone, v.latitude, v.longitude
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
  'Returns the caller''s own non-done orders (phone-scoped when phone present, else device). OTP-off read path for MyOrders; RLS stays restrictive.';

REVOKE ALL ON FUNCTION public.get_my_orders(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_orders(text, text) TO anon, authenticated, service_role;

-- ── 2. get_my_order_bills ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_order_bills(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_request_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  request_id uuid,
  total_amount double precision,
  payment_mode text,
  payment_status text,
  notes text,
  items jsonb,
  is_edited boolean
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

  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_order_bills', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Only bills on requests the caller owns (same identity precedence as the
  -- list), non-void, restricted to the requested batch. Items and the
  -- edited-audit flag are folded in because their customer RLS policies are
  -- blocked by the same auth_user_phone() shape.
  RETURN QUERY
  SELECT
    ob.id, ob.request_id, ob.total_amount, ob.payment_mode, ob.payment_status,
    ob.notes,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'request_id', oi.request_id,
            'description', oi.description,
            'quantity', oi.quantity,
            'unit', oi.unit,
            'unit_price', oi.unit_price,
            'total_price', oi.total_price
          )
          ORDER BY oi.created_at
        )
        FROM public.order_items oi
        WHERE oi.request_id = ob.request_id
      ),
      '[]'::jsonb
    ) AS items,
    EXISTS (
      SELECT 1 FROM public.bill_edit_audit bea WHERE bea.bill_id = ob.id
    ) AS is_edited
  FROM public.order_bills ob
  JOIN public.requests r ON r.id = ob.request_id
  WHERE ob.request_id = ANY (p_request_ids)
    AND ob.payment_status <> 'void'
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN r.user_phone = btrim(p_user_phone)
        ELSE r.device_id = btrim(p_device_id)
      END
    );
END;
$$;

COMMENT ON FUNCTION public.get_my_order_bills(text, text, uuid[]) IS
  'Returns non-void bills (with items + edited flag) for the caller''s own requests in the given batch. OTP-off read path for MyOrders.';

REVOKE ALL ON FUNCTION public.get_my_order_bills(text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_order_bills(text, text, uuid[]) TO anon, authenticated, service_role;

-- ── 3. get_my_khata_ledger ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_khata_ledger(
  p_user_phone text
)
RETURNS TABLE (
  vendor_id uuid,
  total_outstanding double precision,
  last_updated timestamptz,
  shop_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_khata_ledger', 'phone', btrim(p_user_phone), 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT kl.vendor_id, kl.total_outstanding, kl.last_updated, v.shop_name
  FROM public.khata_ledger kl
  LEFT JOIN public.vendors v ON v.id = kl.vendor_id
  WHERE kl.user_phone = btrim(p_user_phone)
  ORDER BY kl.last_updated DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_khata_ledger(text) IS
  'Returns the caller''s own khata ledger strip. Phone-scoped only — khata_ledger has no device identity. OTP-off read path for MyOrders.';

REVOKE ALL ON FUNCTION public.get_my_khata_ledger(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_khata_ledger(text) TO anon, authenticated, service_role;

-- ── 4. get_my_khata_transactions ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_khata_transactions(
  p_user_phone text,
  p_vendor_id uuid
)
RETURNS TABLE (
  id uuid,
  amount numeric,
  note text,
  payment_mode text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_khata_transactions', 'phone', btrim(p_user_phone), 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT kt.id, kt.amount, kt.note, kt.payment_mode, kt.created_at
  FROM public.khata_transactions kt
  WHERE kt.user_phone = btrim(p_user_phone)
    AND kt.vendor_id = p_vendor_id
  ORDER BY kt.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_my_khata_transactions(text, uuid) IS
  'Returns the caller''s own khata transactions with one vendor (detail view). OTP-off read path for MyOrders.';

REVOKE ALL ON FUNCTION public.get_my_khata_transactions(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_khata_transactions(text, uuid) TO anon, authenticated, service_role;
