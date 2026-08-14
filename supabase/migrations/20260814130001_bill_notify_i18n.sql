-- Bill notification i18n: customer lang via notification_i18n + notification_i18n_format.

INSERT INTO public.notification_i18n (copy_key, lang, title, body) VALUES
  ('bill_sent', 'en',
   'Bill from your vendor',
   '{shop_name}: ₹{amount} — {payment_mode}'),
  ('bill_sent', 'hi',
   'विक्रेता से बिल',
   '{shop_name}: ₹{amount} — {payment_mode}'),
  ('bill_sent', 'mr',
   'विक्रेत्याकडून बिल',
   '{shop_name}: ₹{amount} — {payment_mode}'),

  ('bill_payment_cash', 'en', 'Cash', ''),
  ('bill_payment_cash', 'hi', 'नकद', ''),
  ('bill_payment_cash', 'mr', 'रोख', ''),

  ('bill_payment_upi', 'en', 'UPI', ''),
  ('bill_payment_upi', 'hi', 'UPI', ''),
  ('bill_payment_upi', 'mr', 'UPI', ''),

  ('bill_payment_khata', 'en', 'Khata', ''),
  ('bill_payment_khata', 'hi', 'खाता', ''),
  ('bill_payment_khata', 'mr', 'खाता', ''),

  ('bill_vendor_fallback', 'en', 'Vendor', ''),
  ('bill_vendor_fallback', 'hi', 'विक्रेता', ''),
  ('bill_vendor_fallback', 'mr', 'विक्रेता', '')
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

CREATE OR REPLACE FUNCTION public.notify_order_bill_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  notify_url text;
  notify_key text;
  v_shop_name text;
  v_shop_display text;
  v_title text;
  v_body text;
  v_payment_label text;
  v_payment_copy_key text;
  v_vendor_fallback text;
BEGIN
  IF NEW.user_phone IS NULL OR trim(NEW.user_phone) = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_status = 'void' THEN
    RETURN NEW;
  END IF;

  SELECT v.shop_name
  INTO v_shop_name
  FROM public.vendors v
  WHERE v.id = NEW.vendor_id;

  SELECT f.title
  INTO v_vendor_fallback
  FROM public.notification_i18n_format('bill_vendor_fallback', NEW.user_phone, '{}'::jsonb) f;

  v_shop_display := COALESCE(NULLIF(trim(v_shop_name), ''), v_vendor_fallback);

  v_payment_copy_key := CASE NEW.payment_mode
    WHEN 'cash' THEN 'bill_payment_cash'
    WHEN 'upi' THEN 'bill_payment_upi'
    WHEN 'khata' THEN 'bill_payment_khata'
    ELSE NULL
  END;

  IF v_payment_copy_key IS NOT NULL THEN
    SELECT f.title
    INTO v_payment_label
    FROM public.notification_i18n_format(v_payment_copy_key, NEW.user_phone, '{}'::jsonb) f;
  ELSE
    v_payment_label := NEW.payment_mode;
  END IF;

  SELECT f.title, f.body
  INTO v_title, v_body
  FROM public.notification_i18n_format(
    'bill_sent',
    NEW.user_phone,
    jsonb_build_object(
      'shop_name', v_shop_display,
      'amount', round(NEW.total_amount::numeric, 0)::text,
      'payment_mode', v_payment_label
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
    NEW.user_phone,
    'bill',
    v_title,
    v_body,
    'my-orders',
    jsonb_build_object('order_id', NEW.request_id),
    false,
    false
  );

  SELECT value INTO notify_url FROM public.app_config WHERE key = 'edge_function_url';
  SELECT value INTO notify_key FROM public.app_config WHERE key = 'anon_key';

  IF notify_url IS NOT NULL AND notify_key IS NOT NULL
     AND btrim(notify_url) <> '' AND btrim(notify_key) <> ''
  THEN
    PERFORM net.http_post(
      url := notify_url || '/notify-user',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || notify_key
      ),
      body := jsonb_build_object(
        'user_phone', NEW.user_phone,
        'title', v_title,
        'body', v_body,
        'type', 'bill',
        'order_id', NEW.request_id,
        'route', 'my-orders',
        'route_params', jsonb_build_object('order_id', NEW.request_id),
        'skip_inbox', true
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_order_bill_trigger() IS
  'AFTER INSERT on order_bills: localized customer inbox (notification_i18n) + FCM via notify-user with skip_inbox.';
