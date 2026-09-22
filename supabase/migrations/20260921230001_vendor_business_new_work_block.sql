-- Consolidate "can this business take NEW work?" for paused /
-- pending_location_review / scheduled deletion. Same exception codes as today.
-- Does not check is_active or subscription_status.
-- Does not change get_vendors_visible_to_customer (history/tracking).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public.vendor_business_new_work_block(
  p_vendor_id uuid,
  p_category_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN v.deletion_requested_at IS NOT NULL THEN 'vendor_deletion_scheduled'
    WHEN p_category_id IS NULL THEN NULL
    WHEN COALESCE(vc.verification_status, '') = 'pending_location_review'
      THEN 'category_location_review_pending'
    WHEN COALESCE(vc.is_paused, false) THEN 'vendor_not_discoverable'
    ELSE NULL
  END
  FROM public.vendors v
  LEFT JOIN public.vendor_categories vc
    ON vc.vendor_id = v.id
   AND vc.category_id = p_category_id
  WHERE v.id = p_vendor_id
$$;

COMMENT ON FUNCTION public.vendor_business_new_work_block(uuid, uuid) IS
  'NULL = this business may take NEW work. Else exception code: vendor_deletion_scheduled, category_location_review_pending, or vendor_not_discoverable (paused). Does not inspect is_active or subscription_status.';

REVOKE ALL ON FUNCTION public.vendor_business_new_work_block(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_business_new_work_block(uuid, uuid)
  TO anon, authenticated, service_role;

-- ── Radar ────────────────────────────────────────────────────────────────────

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
    AND public.vendor_business_new_work_block(vc.vendor_id, vc.category_id) IS NULL
    AND vcm.mode = lower(trim(p_mode))
    AND (
      p_category_ids IS NULL
      OR cardinality(p_category_ids) = 0
      OR vc.category_id = ANY (p_category_ids)
    );
$$;

COMMENT ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) IS
  'Radar discovery: approved vendor/category pairs offering the mode that can take NEW work (not paused, pending_location_review, or scheduled deletion).';

REVOKE ALL ON FUNCTION public.get_radar_category_mode_matches(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_radar_category_mode_matches(text, uuid[])
  TO anon, authenticated, service_role;

-- ── Booking category resolve ─────────────────────────────────────────────────

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
  v_block text;
BEGIN
  PERFORM public._reject_unapproved_booking_hint(p_vendor_id, p_hint_category_id);

  IF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
  ) THEN
    v_block := public.vendor_business_new_work_block(p_vendor_id, p_hint_category_id);
    IF v_block IS NULL THEN
      v_category_id := p_hint_category_id;
    ELSIF v_block = 'category_location_review_pending' THEN
      RAISE EXCEPTION 'category_location_review_pending';
    ELSIF v_block = 'vendor_deletion_scheduled' THEN
      RAISE EXCEPTION 'vendor_deletion_scheduled';
    ELSE
      RAISE EXCEPTION 'vendor_not_discoverable';
    END IF;
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND public.vendor_business_new_work_block(p_vendor_id, vc.category_id) IS NULL
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id AND vc.status = 'approved'
      ) THEN
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
  'Resolve category_id and service_mode for booking. Uses vendor_business_new_work_block for pause / location-review / scheduled deletion.';

REVOKE ALL ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz)
  TO anon, authenticated, service_role;

-- ── create_customer_request (body matches 20260921180001 + shared gate) ──────

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
  p_service_location text DEFAULT NULL,
  p_client_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_banned boolean;
  v_vendor_discoverable boolean;
  v_customer_banned boolean;
  v_customer_deletion_requested_at timestamptz;
  v_category_id uuid;
  v_service_mode text;
  v_category_modes text[];
  v_service_location text;
  v_delivery_fulfillment_method text;
  v_delivery_payment_timing text;
  v_min_delivery numeric;
  v_items_total numeric;
  v_idem text;
  v_phone text;
  v_block text;
BEGIN
  -- Booking gates identity/ban/discoverable — not is_active or profile_status.
  -- Offline-but-discoverable Delivery/Appointment vendors stay bookable by
  -- design (Radar keeps them visible). Help already filters offline vendors
  -- out of discovery, so no is_active reject is needed here.

  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  v_idem := NULLIF(btrim(COALESCE(p_client_idempotency_key, '')), '');

  IF v_idem IS NOT NULL THEN
    SELECT r.id
    INTO v_id
    FROM public.requests r
    WHERE r.client_idempotency_key = v_idem
      AND r.created_at > now() - interval '2 minutes'
      AND (
        CASE
          WHEN v_phone IS NOT NULL THEN r.user_phone = v_phone
          ELSE r.device_id = p_device_id
        END
      )
    ORDER BY r.created_at DESC
    LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  IF v_phone IS NOT NULL THEN
    SELECT COALESCE(u.is_banned, false), u.deletion_requested_at
    INTO v_customer_banned, v_customer_deletion_requested_at
    FROM public.users u
    WHERE u.phone = v_phone
    LIMIT 1;

    IF COALESCE(v_customer_banned, false) THEN
      RAISE EXCEPTION 'customer_banned';
    END IF;

    IF v_customer_deletion_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'customer_deletion_scheduled';
    END IF;
  END IF;

  IF public._customer_has_unresolved_digital_payment_block(p_user_phone, p_device_id) THEN
    RAISE EXCEPTION 'customer_payment_block';
  END IF;

  SELECT
    COALESCE(v.is_banned, false),
    COALESCE(v.discoverable, false)
  INTO
    v_vendor_banned,
    v_vendor_discoverable
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF v_vendor_banned THEN
    RAISE EXCEPTION 'vendor_banned';
  END IF;

  v_block := public.vendor_business_new_work_block(p_vendor_id, NULL);
  IF v_block = 'vendor_deletion_scheduled' THEN
    RAISE EXCEPTION 'vendor_deletion_scheduled';
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

  PERFORM 1
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = v_category_id
  FOR SHARE;

  v_block := public.vendor_business_new_work_block(p_vendor_id, v_category_id);
  IF v_block = 'vendor_not_discoverable' THEN
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
      vc.delivery_payment_timing,
      vc.min_delivery_order_amount
    INTO v_delivery_fulfillment_method, v_delivery_payment_timing, v_min_delivery
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = v_category_id
    LIMIT 1;

    v_delivery_fulfillment_method := COALESCE(v_delivery_fulfillment_method, 'vendor');
    v_delivery_payment_timing := COALESCE(v_delivery_payment_timing, 'postpaid');
    IF v_delivery_fulfillment_method = 'vendor' THEN
      v_delivery_payment_timing := 'postpaid';
    END IF;

    IF v_min_delivery IS NOT NULL AND v_min_delivery > 0 THEN
      v_items_total := public._delivery_items_subtotal(p_items);
      IF v_items_total < v_min_delivery THEN
        RAISE EXCEPTION 'below_min_delivery_order';
      END IF;
    END IF;
  END IF;

  BEGIN
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
      delivery_payment_timing,
      client_idempotency_key
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
      v_delivery_payment_timing,
      v_idem
    )
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF v_idem IS NULL THEN
        RAISE;
      END IF;
      SELECT r.id
      INTO v_id
      FROM public.requests r
      WHERE r.client_idempotency_key = v_idem
      LIMIT 1;
      IF v_id IS NULL THEN
        RAISE;
      END IF;
      RETURN v_id;
  END;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) IS
  'Create customer request. Gates ban/deletion/discoverable (not is_active). NEW-work pause/location/deletion via vendor_business_new_work_block. Pause check takes FOR SHARE.';

REVOKE ALL ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) TO anon, authenticated, service_role;
