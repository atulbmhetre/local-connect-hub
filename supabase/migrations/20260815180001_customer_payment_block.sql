-- Section 6d: hard block on new orders when unresolved digital-payment bill past 48h grace.
-- Also closes device-only reminder gap in payment hygiene reminders (Section 6a–6c).

-- ============================================================================
-- A. Partial index for unpaid UPI bill lookup by phone
-- ============================================================================

CREATE INDEX IF NOT EXISTS order_bills_unpaid_upi_phone_created_idx
  ON public.order_bills (user_phone, created_at)
  WHERE payment_status = 'unpaid' AND payment_mode = 'upi';

-- ============================================================================
-- B. Shared blocking-bill predicate (internal)
-- ============================================================================

CREATE OR REPLACE FUNCTION public._customer_find_blocking_digital_payment_bill(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid,
  vendor_name text,
  amount double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id AS request_id,
    COALESCE(
      NULLIF(btrim(v.shop_name), ''),
      NULLIF(btrim(v.name), ''),
      'Vendor'
    ) AS vendor_name,
    ob.total_amount AS amount
  FROM public.order_bills ob
  INNER JOIN public.requests r ON r.id = ob.request_id
  INNER JOIN public.vendors v ON v.id = ob.vendor_id
  WHERE ob.payment_status = 'unpaid'
    AND ob.payment_mode = 'upi'
    AND ob.created_at < now() - interval '48 hours'
    AND r.service_mode = 'delivery'
    AND r.delivery_fulfillment_method = 'agent'
    AND r.delivery_payment_timing = 'prepaid'
    AND r.status NOT IN ('cancelled', 'done')
    AND COALESCE(r.payment_status, 'unpaid') NOT IN ('claimed', 'confirmed', 'disputed')
    AND (
      (
        p_user_phone IS NOT NULL
        AND btrim(p_user_phone) <> ''
        AND (
          ob.user_phone = btrim(p_user_phone)
          OR r.user_phone = btrim(p_user_phone)
          OR (
            p_device_id IS NOT NULL
            AND btrim(p_device_id) <> ''
            AND r.device_id IS NOT NULL
            AND r.device_id = btrim(p_device_id)
          )
        )
      )
      OR (
        (p_user_phone IS NULL OR btrim(p_user_phone) = '')
        AND p_device_id IS NOT NULL
        AND btrim(p_device_id) <> ''
        AND r.device_id IS NOT NULL
        AND r.device_id = btrim(p_device_id)
      )
    )
  ORDER BY ob.created_at ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public._customer_find_blocking_digital_payment_bill(text, text) IS
  'Internal: oldest unresolved self-declare-eligible UPI bill past 48h for customer identity.';

REVOKE ALL ON FUNCTION public._customer_find_blocking_digital_payment_bill(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._customer_has_unresolved_digital_payment_block(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public._customer_find_blocking_digital_payment_bill(p_user_phone, p_device_id)
  );
$$;

COMMENT ON FUNCTION public._customer_has_unresolved_digital_payment_block(text, text) IS
  'True when customer has an unresolved digital-payment bill eligible for Section 6d block.';

REVOKE ALL ON FUNCTION public._customer_has_unresolved_digital_payment_block(text, text) FROM PUBLIC;

-- ============================================================================
-- C. Client lookup RPC (mirrors get_customer_payment_restriction_status shape)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_customer_payment_block_status(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  is_blocked boolean,
  vendor_name text,
  amount double precision,
  request_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  RETURN QUERY
  SELECT
    true AS is_blocked,
    b.vendor_name,
    b.amount,
    b.request_id
  FROM public._customer_find_blocking_digital_payment_bill(p_user_phone, p_device_id) b;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT false, NULL::text, NULL::double precision, NULL::uuid;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_customer_payment_block_status(text, text) IS
  'Returns whether customer is blocked from new orders (Section 6d) and blocking bill details when true.';

REVOKE ALL ON FUNCTION public.get_customer_payment_block_status(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_payment_block_status(text, text) TO anon, authenticated, service_role;

-- ============================================================================
-- D. create_customer_request — early guard only (no signature / INSERT changes)
-- ============================================================================

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
    v.profile_status
  INTO v_vendor_active, v_vendor_banned, v_vendor_discoverable, v_vendor_profile_status
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF v_vendor_banned THEN
    RAISE EXCEPTION 'vendor_banned';
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

-- ============================================================================
-- E. send_bill_payment_reminder — device-only recipient resolution (additive)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.send_bill_payment_reminder(
  p_bill_id uuid,
  p_source text,
  p_vendor_id uuid DEFAULT NULL,
  p_vendor_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_bill record;
  v_request record;
  v_shop_name text;
  v_shop_display text;
  v_vendor_fallback text;
  v_copy_key text;
  v_title text;
  v_body text;
  v_notify_url text;
  v_notify_key text;
  v_self_declare_eligible boolean;
  v_recipient_phone text;
  v_recipient_fcm_token text;
  v_i18n_phone text;
  v_notify_body jsonb;
BEGIN
  IF p_source NOT IN ('cron', 'vendor') THEN
    RAISE EXCEPTION 'invalid_source';
  END IF;

  SELECT
    ob.id,
    ob.request_id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode,
    ob.payment_status
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.id = p_bill_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found';
  END IF;

  IF v_bill.payment_status <> 'unpaid' THEN
    RAISE EXCEPTION 'bill_not_unpaid';
  END IF;

  SELECT
    r.id,
    r.status,
    r.payment_status,
    r.service_mode,
    r.delivery_fulfillment_method,
    r.delivery_payment_timing,
    r.user_phone,
    r.device_id
  INTO v_request
  FROM public.requests r
  WHERE r.id = v_bill.request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;

  IF v_request.status IN ('cancelled', 'done') THEN
    RAISE EXCEPTION 'order_closed';
  END IF;

  v_recipient_phone := NULLIF(btrim(v_bill.user_phone), '');
  IF v_recipient_phone IS NULL THEN
    v_recipient_phone := NULLIF(btrim(v_request.user_phone), '');
  END IF;

  v_recipient_fcm_token := NULL;

  IF v_recipient_phone IS NULL
     AND v_request.device_id IS NOT NULL
     AND btrim(v_request.device_id) <> '' THEN
    SELECT
      NULLIF(btrim(ud.user_phone), ''),
      NULLIF(btrim(ud.fcm_token), '')
    INTO v_recipient_phone, v_recipient_fcm_token
    FROM public.user_devices ud
    WHERE ud.device_id = btrim(v_request.device_id)
      AND ud.is_current = true
    ORDER BY ud.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_recipient_phone IS NULL AND v_recipient_fcm_token IS NULL THEN
    RAISE EXCEPTION 'customer_recipient_missing';
  END IF;

  IF p_source = 'vendor' THEN
    IF p_vendor_id IS NULL OR p_vendor_phone IS NULL
       OR btrim(p_vendor_phone) = '' THEN
      RAISE EXCEPTION 'vendor_identity_required';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.vendors v
      WHERE v.id = p_vendor_id
        AND v.phone = btrim(p_vendor_phone)
        AND v.id = v_bill.vendor_id
    ) THEN
      RAISE EXCEPTION 'vendor_unauthorized';
    END IF;
  END IF;

  SELECT v.shop_name
  INTO v_shop_name
  FROM public.vendors v
  WHERE v.id = v_bill.vendor_id;

  v_i18n_phone := COALESCE(v_recipient_phone, '');

  SELECT f.title
  INTO v_vendor_fallback
  FROM public.notification_i18n_format('bill_vendor_fallback', v_i18n_phone, '{}'::jsonb) f;

  v_shop_display := COALESCE(NULLIF(btrim(v_shop_name), ''), v_vendor_fallback);

  v_self_declare_eligible :=
    v_bill.payment_mode = 'upi'
    AND COALESCE(v_request.service_mode, '') = 'delivery'
    AND v_request.delivery_fulfillment_method = 'agent'
    AND v_request.delivery_payment_timing = 'prepaid';

  IF v_request.payment_status = 'claimed' THEN
    v_copy_key := 'bill_reminder_claimed';
  ELSIF v_self_declare_eligible THEN
    v_copy_key := 'bill_reminder_pay_now';
  ELSE
    v_copy_key := 'bill_reminder_generic';
  END IF;

  SELECT f.title, f.body
  INTO v_title, v_body
  FROM public.notification_i18n_format(
    v_copy_key,
    v_i18n_phone,
    jsonb_build_object(
      'shop_name', v_shop_display,
      'amount', round(v_bill.total_amount::numeric, 0)::text
    )
  ) f;

  IF v_recipient_phone IS NOT NULL THEN
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
      v_recipient_phone,
      'bill_payment_reminder',
      v_title,
      v_body,
      'my-orders',
      jsonb_build_object('order_id', v_bill.request_id),
      v_bill.request_id,
      false,
      false
    );
  END IF;

  SELECT value INTO v_notify_url FROM public.app_config WHERE key = 'edge_function_url';
  SELECT value INTO v_notify_key FROM public.app_config WHERE key = 'anon_key';

  IF v_notify_url IS NOT NULL AND v_notify_key IS NOT NULL
     AND btrim(v_notify_url) <> '' AND btrim(v_notify_key) <> ''
  THEN
    v_notify_body := jsonb_build_object(
      'title', v_title,
      'body', v_body,
      'type', 'bill_payment_reminder',
      'order_id', v_bill.request_id,
      'route', 'my-orders',
      'route_params', jsonb_build_object('order_id', v_bill.request_id),
      'skip_inbox', true
    );

    IF v_recipient_phone IS NOT NULL THEN
      v_notify_body := v_notify_body || jsonb_build_object('user_phone', v_recipient_phone);
    END IF;

    IF v_recipient_fcm_token IS NOT NULL THEN
      v_notify_body := v_notify_body || jsonb_build_object('fcm_token', v_recipient_fcm_token);
    END IF;

    PERFORM net.http_post(
      url := v_notify_url || '/notify-user',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_notify_key
      ),
      body := v_notify_body
    );
  END IF;

  IF p_source = 'vendor' THEN
    UPDATE public.order_bills
    SET last_vendor_reminder_at = now()
    WHERE id = p_bill_id;
  END IF;

  RETURN jsonb_build_object(
    'sent', true,
    'copy_key', v_copy_key,
    'bill_id', p_bill_id,
    'source', p_source
  );
END;
$$;

COMMENT ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) IS
  'Sends localized unpaid-bill reminder (inbox + FCM skip_inbox). Supports phone and device-only recipients.';

REVOKE ALL ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) TO anon, authenticated, service_role;

-- ============================================================================
-- F. remind_unpaid_bills — include device-only bills (additive WHERE)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remind_unpaid_bills()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_bill record;
  v_tier1_count integer := 0;
  v_tier2_count integer := 0;
BEGIN
  FOR v_bill IN
    SELECT ob.id
    FROM public.order_bills ob
    INNER JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.payment_status = 'unpaid'
      AND ob.payment_reminder_tier1_at IS NULL
      AND r.status NOT IN ('cancelled', 'done')
      AND now() >= ob.created_at + interval '30 minutes'
      AND (
        (ob.user_phone IS NOT NULL AND btrim(ob.user_phone) <> '')
        OR (r.device_id IS NOT NULL AND btrim(r.device_id) <> '')
      )
  LOOP
    BEGIN
      PERFORM public.send_bill_payment_reminder(v_bill.id, 'cron');
      UPDATE public.order_bills
      SET payment_reminder_tier1_at = now()
      WHERE id = v_bill.id
        AND payment_reminder_tier1_at IS NULL;
      v_tier1_count := v_tier1_count + 1;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;

  FOR v_bill IN
    SELECT ob.id
    FROM public.order_bills ob
    INNER JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.payment_status = 'unpaid'
      AND ob.payment_reminder_tier2_at IS NULL
      AND r.status NOT IN ('cancelled', 'done')
      AND now() >= ob.created_at + interval '24 hours'
      AND (
        (ob.user_phone IS NOT NULL AND btrim(ob.user_phone) <> '')
        OR (r.device_id IS NOT NULL AND btrim(r.device_id) <> '')
      )
  LOOP
    BEGIN
      PERFORM public.send_bill_payment_reminder(v_bill.id, 'cron');
      UPDATE public.order_bills
      SET payment_reminder_tier2_at = now()
      WHERE id = v_bill.id
        AND payment_reminder_tier2_at IS NULL;
      v_tier2_count := v_tier2_count + 1;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'tier1_sent', v_tier1_count,
    'tier2_sent', v_tier2_count
  );
END;
$$;

COMMENT ON FUNCTION public.remind_unpaid_bills() IS
  'Cron: tier-1 (30 min) and tier-2 (24 h) unpaid bill reminders once per bill; phone or device identity.';

REVOKE ALL ON FUNCTION public.remind_unpaid_bills() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remind_unpaid_bills() TO service_role;
