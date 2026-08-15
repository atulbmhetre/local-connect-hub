-- Payment hygiene reminders (Section 6a–6c): per-bill cron tiers + vendor on-demand remind.

-- ============================================================================
-- A. order_bills reminder tracking columns
-- ============================================================================

ALTER TABLE public.order_bills
  ADD COLUMN IF NOT EXISTS payment_reminder_tier1_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_reminder_tier2_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_vendor_reminder_at timestamptz;

COMMENT ON COLUMN public.order_bills.payment_reminder_tier1_at IS
  'Cron tier-1 (30 min unpaid) reminder sent at; NULL until fired once.';
COMMENT ON COLUMN public.order_bills.payment_reminder_tier2_at IS
  'Cron tier-2 (24 h unpaid) reminder sent at; NULL until fired once.';
COMMENT ON COLUMN public.order_bills.last_vendor_reminder_at IS
  'Last vendor manual remind timestamp (informational only, not a rate-limit gate).';

-- ============================================================================
-- B. notification_i18n copy (three actionability branches)
-- ============================================================================

INSERT INTO public.notification_i18n (copy_key, lang, title, body) VALUES
  ('bill_reminder_pay_now', 'en',
   'Payment reminder',
   '{shop_name}: ₹{amount} unpaid — tap Pay Now in My Orders.'),
  ('bill_reminder_pay_now', 'hi',
   'भुगतान अनुस्मारक',
   '{shop_name}: ₹{amount} बकाया — मेरे ऑर्डर में Pay Now दबाएँ।'),
  ('bill_reminder_pay_now', 'mr',
   'पेमेंट स्मरण',
   '{shop_name}: ₹{amount} थकबाकी — माझे ऑर्डरमध्ये Pay Now दाबा.'),

  ('bill_reminder_claimed', 'en',
   'Payment pending confirmation',
   '{shop_name}: your payment is submitted — awaiting vendor confirmation.'),
  ('bill_reminder_claimed', 'hi',
   'भुगतान पुष्टि लंबित',
   '{shop_name}: आपका भुगतान जमा हो गया — विक्रेता की पुष्टि की प्रतीक्षा।'),
  ('bill_reminder_claimed', 'mr',
   'पेमेंट पुष्टी प्रलंबित',
   '{shop_name}: तुमचे पेमेंट सबमिट झाले — विक्रेत्याच्या पुष्टीची वाट.'),

  ('bill_reminder_generic', 'en',
   'Unpaid bill reminder',
   '{shop_name}: ₹{amount} unpaid — contact your vendor to settle.'),
  ('bill_reminder_generic', 'hi',
   'बकाया बिल अनुस्मारक',
   '{shop_name}: ₹{amount} बकाया — भुगतान के लिए विक्रेता से संपर्क करें।'),
  ('bill_reminder_generic', 'mr',
   'थकबाकी बिल स्मरण',
   '{shop_name}: ₹{amount} थकबाकी — भरण्यासाठी विक्रेत्याशी संपर्क साधा.')
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

-- ============================================================================
-- C. send_bill_payment_reminder — shared cron + vendor path
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

  IF v_bill.user_phone IS NULL OR btrim(v_bill.user_phone) = '' THEN
    RAISE EXCEPTION 'customer_phone_missing';
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

  SELECT
    r.id,
    r.status,
    r.payment_status,
    r.service_mode,
    r.delivery_fulfillment_method,
    r.delivery_payment_timing
  INTO v_request
  FROM public.requests r
  WHERE r.id = v_bill.request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;

  IF v_request.status IN ('cancelled', 'done') THEN
    RAISE EXCEPTION 'order_closed';
  END IF;

  SELECT v.shop_name
  INTO v_shop_name
  FROM public.vendors v
  WHERE v.id = v_bill.vendor_id;

  SELECT f.title
  INTO v_vendor_fallback
  FROM public.notification_i18n_format('bill_vendor_fallback', v_bill.user_phone, '{}'::jsonb) f;

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
    v_bill.user_phone,
    jsonb_build_object(
      'shop_name', v_shop_display,
      'amount', round(v_bill.total_amount::numeric, 0)::text
    )
  ) f;

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
    v_bill.user_phone,
    'bill_payment_reminder',
    v_title,
    v_body,
    'my-orders',
    jsonb_build_object('order_id', v_bill.request_id),
    v_bill.request_id,
    false,
    false
  );

  SELECT value INTO v_notify_url FROM public.app_config WHERE key = 'edge_function_url';
  SELECT value INTO v_notify_key FROM public.app_config WHERE key = 'anon_key';

  IF v_notify_url IS NOT NULL AND v_notify_key IS NOT NULL
     AND btrim(v_notify_url) <> '' AND btrim(v_notify_key) <> ''
  THEN
    PERFORM net.http_post(
      url := v_notify_url || '/notify-user',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_notify_key
      ),
      body := jsonb_build_object(
        'user_phone', v_bill.user_phone,
        'title', v_title,
        'body', v_body,
        'type', 'bill_payment_reminder',
        'order_id', v_bill.request_id,
        'route', 'my-orders',
        'route_params', jsonb_build_object('order_id', v_bill.request_id),
        'skip_inbox', true
      )
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
  'Sends localized unpaid-bill reminder (inbox + FCM skip_inbox). Vendor source requires vendor identity; no cooldown.';

REVOKE ALL ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) TO anon, authenticated, service_role;

-- ============================================================================
-- D. remind_unpaid_bills — cron batch (tier 1 = 30 min, tier 2 = 24 h)
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
      AND ob.user_phone IS NOT NULL
      AND btrim(ob.user_phone) <> ''
      AND r.status NOT IN ('cancelled', 'done')
      AND now() >= ob.created_at + interval '30 minutes'
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
      AND ob.user_phone IS NOT NULL
      AND btrim(ob.user_phone) <> ''
      AND r.status NOT IN ('cancelled', 'done')
      AND now() >= ob.created_at + interval '24 hours'
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
  'Cron: send tier-1 (30 min) and tier-2 (24 h) unpaid bill reminders once per bill.';

REVOKE ALL ON FUNCTION public.remind_unpaid_bills() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remind_unpaid_bills() TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'remind-unpaid-bills';

SELECT cron.schedule(
  'remind-unpaid-bills',
  '*/5 * * * *',
  $$SELECT public.remind_unpaid_bills();$$
);

-- ============================================================================
-- E. Extend get_my_order_bills with created_at for client visual weight
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_my_order_bills(text, text, uuid[]);

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
  is_edited boolean,
  created_at timestamptz
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
    ) AS is_edited,
    ob.created_at
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
  'Returns non-void bills (with items, edited flag, created_at) for the caller''s own requests.';

REVOKE ALL ON FUNCTION public.get_my_order_bills(text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_order_bills(text, text, uuid[]) TO anon, authenticated, service_role;

-- ============================================================================
-- F. Extend get_vendor_order_bills with last_vendor_reminder_at
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_vendor_order_bills(uuid, text, uuid[]);

CREATE OR REPLACE FUNCTION public.get_vendor_order_bills(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  request_id uuid,
  total_amount double precision,
  payment_mode text,
  payment_status text,
  last_vendor_reminder_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_order_bills', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    b.id,
    b.request_id,
    b.total_amount,
    b.payment_mode,
    b.payment_status,
    b.last_vendor_reminder_at
  FROM public.order_bills b
  INNER JOIN public.requests r ON r.id = b.request_id
  WHERE r.vendor_id = p_vendor_id
    AND b.request_id = ANY (p_request_ids)
    AND b.payment_status <> 'void';
END;
$$;

COMMENT ON FUNCTION public.get_vendor_order_bills(uuid, text, uuid[]) IS
  'OTP-off non-void bills for the vendor''s own request ids (includes last_vendor_reminder_at).';

REVOKE ALL ON FUNCTION public.get_vendor_order_bills(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_order_bills(uuid, text, uuid[]) TO anon, authenticated, service_role;
