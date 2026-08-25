-- Hide scheduled-deletion vendors from new customer discovery / booking.
-- Same three surfaces as pending_location_review (radar RPC, booking gate, plus
-- vendors_public_discoverable_read RLS). Do not change get_vendors_visible_to_customer:
-- existing order history / tracking must still resolve the shop during the window.

-- ── 1. Radar discovery ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_radar_category_mode_matches(
  p_mode text,
  p_category_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (vendor_id uuid, category_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT vc.vendor_id, vc.category_id
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  JOIN public.vendors v ON v.id = vc.vendor_id
  WHERE vc.status = 'approved'
    AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    AND v.deletion_requested_at IS NULL
    AND vcm.mode = lower(trim(p_mode))
    AND (
      p_category_ids IS NULL
      OR cardinality(p_category_ids) = 0
      OR vc.category_id = ANY (p_category_ids)
    );
$$;

COMMENT ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) IS
  'Radar discovery: approved vendor/category pairs offering the given availability mode; excludes pending_location_review and scheduled-deletion vendors.';

REVOKE ALL ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_radar_category_mode_matches(text, uuid[])
  TO anon, authenticated, service_role;

-- ── 2. Booking: create_customer_request vendor gate ─────────────────────────

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
  p_category_id uuid DEFAULT NULL,
  p_service_mode text DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_service_location text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_active boolean;
  v_vendor_banned boolean;
  v_vendor_discoverable boolean;
  v_vendor_profile_status text;
  v_vendor_deletion_requested_at timestamptz;
  v_customer_banned boolean;
  v_category_id uuid;
  v_service_mode text;
  v_category_modes text[];
  v_service_location text;
  v_delivery_fulfillment_method text;
  v_delivery_payment_timing text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    SELECT COALESCE(u.is_banned, false)
    INTO v_customer_banned
    FROM public.users u
    WHERE u.phone = btrim(p_user_phone)
    LIMIT 1;

    IF COALESCE(v_customer_banned, false) THEN
      RAISE EXCEPTION 'customer_banned';
    END IF;
  END IF;

  IF public._customer_has_unresolved_digital_payment_block(p_user_phone, p_device_id) THEN
    RAISE EXCEPTION 'customer_payment_block';
  END IF;

  SELECT
    COALESCE(v.is_active, false),
    COALESCE(v.is_banned, false),
    COALESCE(v.discoverable, false),
    v.profile_status,
    v.deletion_requested_at
  INTO
    v_vendor_active,
    v_vendor_banned,
    v_vendor_discoverable,
    v_vendor_profile_status,
    v_vendor_deletion_requested_at
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF v_vendor_banned THEN
    RAISE EXCEPTION 'vendor_banned';
  END IF;

  IF v_vendor_deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;

  IF NOT v_vendor_discoverable THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;

  SELECT category_id, service_mode
  INTO v_category_id, v_service_mode
  FROM public._resolve_booking_category(
    p_vendor_id,
    p_category_id,
    p_service_mode,
    p_delivery_slot,
    p_appointment_time
  );

  SELECT COALESCE(array_agg(vcm.mode), ARRAY[]::text[])
  INTO v_category_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id AND vc.category_id = v_category_id;

  IF v_category_modes IS NOT NULL AND array_length(v_category_modes, 1) > 0 AND NOT (v_service_mode = ANY(v_category_modes)) THEN
    RAISE EXCEPTION 'service_mode_unavailable';
  END IF;

  v_service_location := NULLIF(btrim(p_service_location), '');
  IF v_service_location IS NOT NULL AND v_service_location NOT IN ('customer_place', 'vendor_place') THEN
    RAISE EXCEPTION 'invalid_service_location';
  END IF;

  v_delivery_fulfillment_method := NULL;
  v_delivery_payment_timing := NULL;
  IF v_service_mode = 'delivery' THEN
    SELECT
      vc.delivery_fulfillment_method,
      vc.delivery_payment_timing
    INTO v_delivery_fulfillment_method, v_delivery_payment_timing
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = v_category_id
    LIMIT 1;

    v_delivery_fulfillment_method := COALESCE(v_delivery_fulfillment_method, 'vendor');
    v_delivery_payment_timing := COALESCE(v_delivery_payment_timing, 'postpaid');
    IF v_delivery_fulfillment_method = 'vendor' THEN
      v_delivery_payment_timing := 'postpaid';
    END IF;
  END IF;

  INSERT INTO public.requests (
    device_id,
    vendor_id,
    message,
    user_phone,
    delivery_address,
    delivery_slot,
    delivery_slot_deadline,
    appointment_time,
    appointment_status,
    customer_latitude,
    customer_longitude,
    category_id,
    service_mode,
    items,
    service_location,
    delivery_fulfillment_method,
    delivery_payment_timing
  )
  VALUES (
    p_device_id,
    p_vendor_id,
    p_message,
    p_user_phone,
    p_delivery_address,
    p_delivery_slot,
    p_delivery_slot_deadline,
    p_appointment_time,
    p_appointment_status,
    p_customer_latitude,
    p_customer_longitude,
    v_category_id,
    v_service_mode,
    p_items,
    v_service_location,
    v_delivery_fulfillment_method,
    v_delivery_payment_timing
  )
  RETURNING id INTO v_id;

  IF NOT v_vendor_active THEN
    NULL;
  END IF;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
) IS
  'Create customer request. Rejects banned/non-discoverable/scheduled-deletion vendors, banned customers, payment blocks, and categories in pending_location_review.';

REVOKE ALL ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
) TO anon, authenticated, service_role;

-- ── 3. Public discovery RLS ─────────────────────────────────────────────────

DROP POLICY IF EXISTS vendors_public_discoverable_read ON public.vendors;

CREATE POLICY vendors_public_discoverable_read ON public.vendors
  FOR SELECT
  TO anon, authenticated
  USING (
    discoverable = true
    AND is_banned = false
    AND profile_status = 'complete'
    AND deletion_requested_at IS NULL
  );

COMMENT ON POLICY vendors_public_discoverable_read ON public.vendors IS
  'Customer discovery (Radar, feed vendor search): only discoverable, non-banned, complete profiles that are not scheduled for deletion.';
