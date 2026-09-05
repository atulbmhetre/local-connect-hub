-- Client idempotency for create_customer_request (lost-response + retry).
-- Same identity + same key within 2 minutes returns the existing request id.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS client_idempotency_key text;

COMMENT ON COLUMN public.requests.client_idempotency_key IS
  'Optional client UUID per order-placement attempt; used to dedupe lost-response retries.';

CREATE UNIQUE INDEX IF NOT EXISTS requests_client_idempotency_key_uidx
  ON public.requests (client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;

DROP FUNCTION IF EXISTS public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
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
  v_min_delivery numeric;
  v_items_total numeric;
  v_idem text;
  v_phone text;
BEGIN
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
    SELECT COALESCE(u.is_banned, false)
    INTO v_customer_banned
    FROM public.users u
    WHERE u.phone = v_phone
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

  IF NOT v_vendor_active THEN
    NULL;
  END IF;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text, text
) IS
  'Create customer request. Optional p_client_idempotency_key dedupes same-identity retries within 2 minutes.';

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
