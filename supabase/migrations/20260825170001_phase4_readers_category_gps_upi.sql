-- Phase 4 readers: get_my_orders returns request category_id + that business's
-- GPS (vendor_categories). UPI stamper reads vendor_categories, not vendors.
-- Null requests.category_id → null business GPS/UPI (no vendors.* fallback).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

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
  ORDER BY r.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_orders(text, text) IS
  'Customer order list: vendor_latitude/longitude are the request category''s vendor_categories pin. Null category_id → null GPS (no vendors.* fallback).';

REVOKE ALL ON FUNCTION public.get_my_orders(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_orders(text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._stamp_request_upi_payee(
  p_request_id uuid,
  p_kind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_category_id uuid;
  v_mode text;
  v_upi_id text;
  v_upi_qr_url text;
  v_upi_payee_id text;
BEGIN
  IF p_kind NOT IN ('intended', 'claimed') THEN
    RAISE EXCEPTION 'invalid_upi_snapshot_kind';
  END IF;

  SELECT r.vendor_id, r.category_id
  INTO v_vendor_id, v_category_id
  FROM public.requests r
  WHERE r.id = p_request_id;

  IF v_vendor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT ob.payment_mode
  INTO v_mode
  FROM public.order_bills ob
  WHERE ob.request_id = p_request_id
    AND ob.payment_status IS DISTINCT FROM 'void'
  LIMIT 1;

  IF v_mode IS DISTINCT FROM 'upi' THEN
    IF p_kind = 'intended' THEN
      UPDATE public.requests
      SET
        intended_upi_id = NULL,
        intended_upi_qr_url = NULL,
        intended_upi_payee_id = NULL
      WHERE id = p_request_id;
    END IF;
    RETURN;
  END IF;

  -- Phase 4: per-business UPI. Null category_id or missing row → null snapshot.
  IF v_category_id IS NOT NULL THEN
    SELECT
      NULLIF(btrim(vc.upi_id), ''),
      NULLIF(btrim(vc.upi_qr_url), ''),
      NULLIF(btrim(vc.upi_qr_payee_id), '')
    INTO v_upi_id, v_upi_qr_url, v_upi_payee_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = v_vendor_id
      AND vc.category_id = v_category_id;
  END IF;

  IF p_kind = 'intended' THEN
    UPDATE public.requests
    SET
      intended_upi_id = v_upi_id,
      intended_upi_qr_url = v_upi_qr_url,
      intended_upi_payee_id = v_upi_payee_id
    WHERE id = p_request_id;
  ELSE
    UPDATE public.requests
    SET
      claimed_upi_id = v_upi_id,
      claimed_upi_qr_url = v_upi_qr_url,
      claimed_upi_payee_id = v_upi_payee_id
    WHERE id = p_request_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public._stamp_request_upi_payee(uuid, text) IS
  'Internal: snapshot vendor_categories UPI onto requests as intended or claimed. Null category_id → null payee. Cash/khata skip claimed and clear intended.';

REVOKE ALL ON FUNCTION public._stamp_request_upi_payee(uuid, text) FROM PUBLIC;

COMMENT ON COLUMN public.vendor_categories.upi_id IS
  'Per-business UPI VPA. Phase 4 readers (Radar, Parchi, payment stamper) use this column.';
COMMENT ON COLUMN public.vendor_categories.upi_qr_url IS
  'Per-business UPI QR image URL. Phase 4 payment readers use this column.';
COMMENT ON COLUMN public.vendor_categories.upi_qr_payee_id IS
  'Per-business decoded QR payee. Phase 4 payment readers use this column.';
