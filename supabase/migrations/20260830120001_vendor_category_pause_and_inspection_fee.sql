-- Per-business pause + optional inspection/visit fee.
-- Pause is vendor_categories-grained (not vendors.is_paused — no such column).
-- Discovery exclusion mirrors deletion_requested_at: radar RPC, booking gate,
-- public discoverable RLS. Do not change get_vendors_visible_to_customer.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS is_paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS inspection_fee numeric(10, 2) NULL;

ALTER TABLE public.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_inspection_fee_nonneg;

ALTER TABLE public.vendor_categories
  ADD CONSTRAINT vendor_categories_inspection_fee_nonneg
  CHECK (inspection_fee IS NULL OR inspection_fee > 0);

COMMENT ON COLUMN public.vendor_categories.is_paused IS
  'When true, this business is hidden from Radar/Home discovery and new-order creation. Existing orders/history are unchanged.';

COMMENT ON COLUMN public.vendor_categories.inspection_fee IS
  'Optional fixed visit/inspection fee in rupees. NULL = unset (not shown).';

CREATE INDEX IF NOT EXISTS vendor_categories_paused_idx
  ON public.vendor_categories (vendor_id)
  WHERE is_paused = true;

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
    AND COALESCE(vc.is_paused, false) = false
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
  'Radar discovery: approved unpaused vendor/category pairs offering the given availability mode; excludes pending_location_review and scheduled-deletion vendors.';

REVOKE ALL ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_radar_category_mode_matches(text, uuid[])
  TO anon, authenticated, service_role;

-- ── 2. Booking category resolve: paused businesses are not bookable ─────────

DROP FUNCTION IF EXISTS public._resolve_booking_category(uuid, uuid, text);
DROP FUNCTION IF EXISTS public._resolve_booking_category(uuid, uuid, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public._resolve_booking_category(
  p_vendor_id uuid,
  p_hint_category_id uuid DEFAULT NULL,
  p_hint_service_mode text DEFAULT NULL,
  p_delivery_slot text DEFAULT NULL,
  p_appointment_time timestamptz DEFAULT NULL
)
RETURNS TABLE(category_id uuid, service_mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_id uuid;
  v_service_mode text;
  v_category_scalar text;
  v_vendor_scalar text;
  v_category_modes text[];
BEGIN
  IF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = false
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
  ) THEN
    v_category_id := p_hint_category_id;
  ELSIF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND vc.verification_status = 'pending_location_review'
  ) THEN
    RAISE EXCEPTION 'category_location_review_pending';
  ELSIF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = true
  ) THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = false
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id AND vc.status = 'approved'
      ) THEN
        -- Approved businesses exist but all are paused or pending location review.
        RAISE EXCEPTION 'vendor_not_discoverable';
      END IF;
      SELECT c.id
      INTO v_category_id
      FROM public.vendors v
      JOIN public.categories c ON c.label = v.category
      WHERE v.id = p_vendor_id
      LIMIT 1;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(vcm.mode), ARRAY[]::text[])
  INTO v_category_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = v_category_id;

  IF p_hint_service_mode IS NOT NULL AND trim(p_hint_service_mode) <> '' THEN
    v_service_mode := lower(trim(p_hint_service_mode));
    IF v_service_mode NOT IN ('help', 'delivery', 'appointment') THEN
      RAISE EXCEPTION 'invalid_service_mode';
    END IF;

    IF COALESCE(array_length(v_category_modes, 1), 0) > 0
       AND NOT (v_service_mode = ANY (v_category_modes))
    THEN
      RAISE EXCEPTION 'service_mode_not_available_for_category';
    END IF;
  ELSE
    IF COALESCE(array_length(v_category_modes, 1), 0) > 0 THEN
      IF p_delivery_slot IS NOT NULL AND 'delivery' = ANY (v_category_modes) THEN
        v_service_mode := 'delivery';
      ELSIF p_appointment_time IS NOT NULL AND 'appointment' = ANY (v_category_modes) THEN
        v_service_mode := 'appointment';
      ELSE
        SELECT vc.service_mode
        INTO v_category_scalar
        FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id
          AND vc.category_id = v_category_id
        LIMIT 1;

        v_service_mode := COALESCE(v_category_scalar, 'help');
      END IF;
    ELSE
      SELECT vc.service_mode
      INTO v_category_scalar
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.category_id = v_category_id
      LIMIT 1;

      SELECT v.service_mode
      INTO v_vendor_scalar
      FROM public.vendors v
      WHERE v.id = p_vendor_id;

      v_service_mode := COALESCE(
        v_category_scalar,
        v_vendor_scalar,
        CASE
          WHEN p_delivery_slot IS NOT NULL THEN 'delivery'
          WHEN p_appointment_time IS NOT NULL THEN 'appointment'
          ELSE 'help'
        END
      );
    END IF;
  END IF;

  category_id := v_category_id;
  service_mode := v_service_mode;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) IS
  'Resolve category_id and service_mode for booking. Skips paused and pending_location_review businesses.';

REVOKE ALL ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz)
  TO anon, authenticated, service_role;

-- ── 3. create_customer_request vendor/business gate ─────────────────────────

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
  v_business_paused boolean;
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

  SELECT COALESCE(vc.is_paused, false)
  INTO v_business_paused
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = v_category_id
  LIMIT 1;

  IF COALESCE(v_business_paused, false) THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;

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
  'Create customer request. Rejects banned/non-discoverable/scheduled-deletion vendors, paused businesses, banned customers, payment blocks, and categories in pending_location_review.';

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

-- ── 4. Public discovery RLS ─────────────────────────────────────────────────

DROP POLICY IF EXISTS vendors_public_discoverable_read ON public.vendors;

CREATE POLICY vendors_public_discoverable_read ON public.vendors
  FOR SELECT
  TO anon, authenticated
  USING (
    discoverable = true
    AND is_banned = false
    AND profile_status = 'complete'
    AND deletion_requested_at IS NULL
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.vendor_categories vc
        WHERE vc.vendor_id = vendors.id AND vc.status = 'approved'
      )
      OR EXISTS (
        SELECT 1 FROM public.vendor_categories vc
        WHERE vc.vendor_id = vendors.id
          AND vc.status = 'approved'
          AND COALESCE(vc.is_paused, false) = false
      )
    )
  );

COMMENT ON POLICY vendors_public_discoverable_read ON public.vendors IS
  'Customer discovery: discoverable, non-banned, complete profiles not scheduled for deletion, with at least one unpaused approved business (or no vendor_categories rows).';

DROP POLICY IF EXISTS vendor_categories_public_read ON public.vendor_categories;

CREATE POLICY vendor_categories_public_read ON public.vendor_categories
  FOR SELECT
  TO anon, authenticated
  USING (
    status = 'approved'
    AND COALESCE(is_paused, false) = false
  );

COMMENT ON POLICY vendor_categories_public_read ON public.vendor_categories IS
  'Public Radar/Home read of approved, unpaused businesses. Owner policy still sees paused rows.';

-- ── 5. Patch pause + inspection_fee via existing per-business profile RPC ───

CREATE OR REPLACE FUNCTION public.vendor_update_category_profile(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee numeric;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_patch ? 'inspection_fee' THEN
    IF p_patch->>'inspection_fee' IS NULL OR btrim(p_patch->>'inspection_fee') = '' THEN
      v_fee := NULL;
    ELSE
      v_fee := (p_patch->>'inspection_fee')::numeric;
      IF v_fee IS NOT NULL AND v_fee <= 0 THEN
        v_fee := NULL;
      END IF;
      IF v_fee IS NOT NULL AND v_fee > 99999 THEN
        RAISE EXCEPTION 'inspection_fee_invalid';
      END IF;
    END IF;
  END IF;

  UPDATE public.vendor_categories vc
  SET
    brand_name = CASE
      WHEN p_patch ? 'brand_name' THEN NULLIF(trim(p_patch->>'brand_name'), '')
      ELSE vc.brand_name
    END,
    vendor_note = CASE
      WHEN p_patch ? 'vendor_note' THEN NULLIF(trim(p_patch->>'vendor_note'), '')
      ELSE vc.vendor_note
    END,
    serves_at_vendor_place = CASE
      WHEN p_patch ? 'serves_at_vendor_place' THEN (p_patch->>'serves_at_vendor_place')::boolean
      ELSE vc.serves_at_vendor_place
    END,
    serves_at_customer_place = CASE
      WHEN p_patch ? 'serves_at_customer_place' THEN (p_patch->>'serves_at_customer_place')::boolean
      ELSE vc.serves_at_customer_place
    END,
    service_radius_km = CASE
      WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::numeric
      ELSE vc.service_radius_km
    END,
    is_paused = CASE
      WHEN p_patch ? 'is_paused' THEN COALESCE((p_patch->>'is_paused')::boolean, false)
      ELSE vc.is_paused
    END,
    inspection_fee = CASE
      WHEN p_patch ? 'inspection_fee' THEN v_fee
      ELSE vc.inspection_fee
    END
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) IS
  'Owner patch of per-business note/reach/pause/inspection_fee. Hybrid session assert when Auth is present.';

REVOKE ALL ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb)
  TO anon, authenticated;
