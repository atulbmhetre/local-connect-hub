-- Payment hygiene reminders: cron tier1 (30m) / tier2 (24h) + vendor "Remind customer".

ALTER TABLE public.order_bills
  ADD COLUMN IF NOT EXISTS payment_reminder_tier1_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_reminder_tier2_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_vendor_reminder_at timestamptz;

INSERT INTO public.notification_i18n (copy_key, lang, title, body) VALUES
  ('bill_reminder_claimed', 'en',
   'Payment reminder',
   '{shop_name}: ₹{amount} — your UTR is awaiting vendor confirmation. No need to pay again.'),
  ('bill_reminder_claimed', 'hi',
   'भुगतान अनुस्मारक',
   '{shop_name}: ₹{amount} — आपका UTR विक्रेता की पुष्टि की प्रतीक्षा में है। दोबारा भुगतान की आवश्यकता नहीं।'),
  ('bill_reminder_claimed', 'mr',
   'पेमेंट स्मरण',
   '{shop_name}: ₹{amount} — तुमचा UTR विक्रेत्याच्या पुष्टीची वाट पाहत आहे. पुन्हा पैसे देण्याची गरज नाही.'),

  ('bill_reminder_pay_now', 'en',
   'Payment reminder',
   '{shop_name}: ₹{amount} is still unpaid. Tap Pay Now in My Orders to complete payment.'),
  ('bill_reminder_pay_now', 'hi',
   'भुगतान अनुस्मारक',
   '{shop_name}: ₹{amount} अभी भी बकाया है। भुगतान पूरा करने के लिए मेरे ऑर्डर में अभी भुगतान करें पर टैप करें।'),
  ('bill_reminder_pay_now', 'mr',
   'पेमेंट स्मरण',
   '{shop_name}: ₹{amount} अजून थकीत आहे. पेमेंट पूर्ण करण्यासाठी माझे ऑर्डर मध्ये आता पैसे द्या वर टॅप करा.'),

  ('bill_reminder_generic', 'en',
   'Payment reminder',
   '{shop_name}: ₹{amount} is still unpaid. Please contact the vendor to pay.'),
  ('bill_reminder_generic', 'hi',
   'भुगतान अनुस्मारक',
   '{shop_name}: ₹{amount} अभी भी बकाया है। भुगतान के लिए विक्रेता से संपर्क करें।'),
  ('bill_reminder_generic', 'mr',
   'पेमेंट स्मरण',
   '{shop_name}: ₹{amount} अजून थकीत आहे. पेमेंटसाठी विक्रेत्याशी संपर्क साधा.')
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

CREATE OR REPLACE FUNCTION public.send_bill_payment_reminder(
  p_bill_id uuid,
  p_source text,
  p_vendor_id uuid DEFAULT NULL,
  p_vendor_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.order_bills%ROWTYPE;
  v_request public.requests%ROWTYPE;
  v_vendor public.vendors%ROWTYPE;
  v_copy_key text;
  v_title text;
  v_body text;
  v_shop_display text;
  v_vendor_fallback text;
  notify_url text;
  notify_key text;
BEGIN
  IF p_source NOT IN ('cron', 'vendor') THEN
    RAISE EXCEPTION 'invalid_source';
  END IF;

  IF p_source = 'vendor' THEN
    PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);
  END IF;

  SELECT ob.*
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.id = p_bill_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found';
  END IF;

  IF v_bill.payment_status <> 'unpaid' THEN
    RAISE EXCEPTION 'bill_not_unpaid';
  END IF;

  IF p_source = 'vendor' THEN
    IF v_bill.vendor_id IS DISTINCT FROM p_vendor_id THEN
      RAISE EXCEPTION 'not_found_or_unauthorized';
    END IF;
  END IF;

  SELECT r.*
  INTO v_request
  FROM public.requests r
  WHERE r.id = v_bill.request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;

  IF v_request.status IN ('cancelled', 'expired', 'declined', 'done') THEN
    RAISE EXCEPTION 'order_not_active';
  END IF;

  IF v_bill.user_phone IS NULL OR btrim(v_bill.user_phone) = '' THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  SELECT v.*
  INTO v_vendor
  FROM public.vendors v
  WHERE v.id = v_bill.vendor_id;

  SELECT f.title
  INTO v_vendor_fallback
  FROM public.notification_i18n_format('bill_vendor_fallback', v_bill.user_phone, '{}'::jsonb) f;

  v_shop_display := COALESCE(NULLIF(trim(v_vendor.shop_name), ''), v_vendor_fallback);

  IF COALESCE(v_request.payment_status, 'unpaid') = 'claimed' THEN
    v_copy_key := 'bill_reminder_claimed';
  ELSIF v_bill.payment_mode = 'upi'
    AND v_bill.payment_mode <> 'khata'
    AND v_vendor.service_mode IN ('delivery', 'help')
  THEN
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
    false,
    false
  );

  SELECT NULLIF(trim(value), '')
  INTO notify_url
  FROM public.app_config
  WHERE key = 'edge_function_url';

  SELECT NULLIF(trim(value), '')
  INTO notify_key
  FROM public.app_config
  WHERE key = 'anon_key';

  IF notify_url IS NOT NULL AND notify_key IS NOT NULL THEN
    PERFORM net.http_post(
      url := notify_url || '/notify-user',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || notify_key
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
END;
$$;

COMMENT ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) IS
  'Sends a localized unpaid-bill payment reminder to the customer (inbox + FCM skip_inbox). Vendor source has no server cooldown.';

REVOKE ALL ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_bill_payment_reminder(uuid, text, uuid, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.remind_unpaid_bills()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT ob.id
    FROM public.order_bills ob
    INNER JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.payment_status = 'unpaid'
      AND ob.user_phone IS NOT NULL
      AND btrim(ob.user_phone) <> ''
      AND r.status NOT IN ('cancelled', 'expired', 'declined', 'done')
      AND ob.payment_reminder_tier1_at IS NULL
      AND ob.created_at <= now() - interval '30 minutes'
  LOOP
    PERFORM public.send_bill_payment_reminder(rec.id, 'cron');
    UPDATE public.order_bills
    SET payment_reminder_tier1_at = now()
    WHERE id = rec.id;
  END LOOP;

  FOR rec IN
    SELECT ob.id
    FROM public.order_bills ob
    INNER JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.payment_status = 'unpaid'
      AND ob.user_phone IS NOT NULL
      AND btrim(ob.user_phone) <> ''
      AND r.status NOT IN ('cancelled', 'expired', 'declined', 'done')
      AND ob.payment_reminder_tier1_at IS NOT NULL
      AND ob.payment_reminder_tier2_at IS NULL
      AND ob.created_at <= now() - interval '24 hours'
  LOOP
    PERFORM public.send_bill_payment_reminder(rec.id, 'cron');
    UPDATE public.order_bills
    SET payment_reminder_tier2_at = now()
    WHERE id = rec.id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.remind_unpaid_bills() IS
  'Cron helper: tier1 at 30m, tier2 at 24h for unpaid bills on active orders.';

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

-- Extend get_my_order_bills with created_at
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
  'Returns non-void bills (with items + edited flag + created_at) for the caller''s own requests in the given batch.';

REVOKE ALL ON FUNCTION public.get_my_order_bills(text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_order_bills(text, text, uuid[]) TO anon, authenticated, service_role;

-- Extend get_vendor_order_bills with last_vendor_reminder_at
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
