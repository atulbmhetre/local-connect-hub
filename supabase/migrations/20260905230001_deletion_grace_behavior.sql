-- Deletion-grace product behavior (customer + vendor).
-- Vendor: clear reject on new booking when deletion_requested_at set.
-- Customer: reject new placement; cancel open orders + notify; khata outstanding notify.
-- Existing vendor obligations (accept/fulfill/bill/khata) unchanged.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

-- ── i18n for deletion-grace vendor notifies ───────────────────────────────────
INSERT INTO public.notification_i18n (copy_key, lang, title, body) VALUES
  (
    'customer_deletion_khata_outstanding',
    'en',
    'Customer scheduled account deletion',
    'A customer who owes you ₹{amount} on Khata has requested account deletion. Settle or record this balance before their identity is anonymized after 30 days.'
  ),
  (
    'customer_deletion_khata_outstanding',
    'hi',
    'ग्राहक ने खाता हटाने का अनुरोध किया',
    'एक ग्राहक जिस पर आपका ख़ाता ₹{amount} बकाया है, ने खाता हटाने का अनुरोध किया है। 30 दिनों में पहचान गुमनाम होने से पहले निपटान करें।'
  ),
  (
    'customer_deletion_khata_outstanding',
    'mr',
    'ग्राहकाने खाते हटवण्याची विनंती केली',
    'ज्या ग्राहकाकडे तुमच्या ख़ात्यावर ₹{amount} बाकी आहे त्यांनी खाते हटवण्याची विनंती केली आहे. ३० दिवसांनी ओळख गुप्त होण्यापूर्वी निपटारा करा.'
  )
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title, body = EXCLUDED.body;

-- ── create_customer_request: customer deletion gate + clear vendor deletion error ─
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
  v_customer_deletion_requested_at timestamptz;
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
  'Create customer request. Rejects customer_deletion_scheduled / vendor_deletion_scheduled; optional idempotency key.';

-- ── Finalize customer deletion request (orders + khata notifies) ─────────────
CREATE OR REPLACE FUNCTION public.finalize_customer_deletion_request(p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_phone text := NULLIF(btrim(COALESCE(p_phone, '')), '');
  rec record;
  v_was_engaged boolean;
  v_cancelled int := 0;
  v_khata_notified int := 0;
  v_title text;
  v_body text;
  v_vendor_phone text;
  v_amount text;
BEGIN
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'phone_required';
  END IF;

  -- Stop future recurring spawns for this customer.
  UPDATE public.recurring_orders
  SET status = 'cancelled', updated_at = now()
  WHERE user_phone = v_phone
    AND status IN ('active', 'paused');

  FOR rec IN
    SELECT
      r.id,
      r.vendor_id,
      r.status,
      r.appointment_status,
      r.appointment_time
    FROM public.requests r
    WHERE r.user_phone = v_phone
      AND r.status IN ('sent', 'seen', 'accepted')
    FOR UPDATE OF r
  LOOP
    v_was_engaged := (
      rec.status IN ('accepted', 'fulfilled')
      OR COALESCE(rec.appointment_status, '') = 'confirmed'
    );

    UPDATE public.requests
    SET
      status = 'cancelled',
      appointment_status = CASE
        WHEN rec.appointment_time IS NOT NULL THEN 'cancelled'
        ELSE appointment_status
      END,
      updated_at = now()
    WHERE id = rec.id;

    UPDATE public.order_bills
    SET payment_status = 'void'
    WHERE request_id = rec.id
      AND payment_status <> 'paid';

    v_cancelled := v_cancelled + 1;

    -- Engaged cancels: lifecycle trigger already notifies vendor (cancel_reason null).
    -- Unengaged (sent/seen): notify explicitly so the vendor is not silent.
    IF NOT v_was_engaged THEN
      SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone
      FROM public.vendors WHERE id = rec.vendor_id;
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'customer_cancelled', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
      ) f;
      PERFORM public._vendor_inbox_and_fcm(
        rec.vendor_id, v_title, v_body, 'order_update', 'vendor',
        jsonb_build_object('order_id', rec.id), rec.id, rec.id, NULL, false
      );
    END IF;
  END LOOP;

  -- Distinct Khata outstanding notify (not folded into cancel copy).
  FOR rec IN
    SELECT kl.vendor_id, kl.total_outstanding
    FROM public.khata_ledger kl
    WHERE kl.user_phone = v_phone
      AND COALESCE(kl.total_outstanding, 0) > 0
  LOOP
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone
    FROM public.vendors WHERE id = rec.vendor_id;
    v_amount := COALESCE(to_char(round(rec.total_outstanding::numeric, 2), 'FM999999990.00'), '0');
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'customer_deletion_khata_outstanding',
      COALESCE(v_vendor_phone, 'en'),
      jsonb_build_object('amount', v_amount)
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      rec.vendor_id, v_title, v_body, 'account_deletion_khata', 'vendor',
      jsonb_build_object('user_phone_tail', right(v_phone, 4)), NULL, NULL, NULL, false
    );
    v_khata_notified := v_khata_notified + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'cancelled_orders', v_cancelled,
    'khata_vendors_notified', v_khata_notified
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_customer_deletion_request(text) IS
  'On customer deletion schedule: cancel open orders (status=cancelled), void unpaid bills, stop recurring, notify vendors (cancel + distinct khata). service_role only.';

REVOKE ALL ON FUNCTION public.finalize_customer_deletion_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_customer_deletion_request(text) TO service_role;
