-- Notification system hardening: vendor_id rate-limit identifier, i18n copy
-- table + helpers, localized near-deadline / expiry / offline / create-request
-- notices, unread notification archival (180d), and admin FCM failure stats RPC.

-- ============================================================================
-- A. Rate limit identifier_type: add 'vendor_id'
-- ============================================================================

alter table public.edge_function_rate_limits
  drop constraint if exists edge_function_rate_limits_identifier_type_check;
alter table public.edge_function_rate_limits
  add constraint edge_function_rate_limits_identifier_type_check
  check (identifier_type in ('device_id', 'ip', 'phone', 'vendor_id'));

-- ============================================================================
-- B. notification_i18n table + helpers
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notification_i18n (
  copy_key text NOT NULL,
  lang text NOT NULL CHECK (lang IN ('en', 'hi', 'mr')),
  title text NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (copy_key, lang)
);

COMMENT ON TABLE public.notification_i18n IS
  'Localized notification title/body templates keyed by copy_key and lang (en/hi/mr).';

CREATE OR REPLACE FUNCTION public.resolve_user_lang(p_user_phone text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT a.lang
      FROM public.app_users a
      WHERE a.phone = p_user_phone
        AND a.lang IN ('en', 'hi', 'mr')
      LIMIT 1
    ),
    'en'
  );
$$;

COMMENT ON FUNCTION public.resolve_user_lang(text) IS
  'Returns app_users.lang for the phone, defaulting to en.';

CREATE OR REPLACE FUNCTION public.notification_i18n_format(
  p_copy_key text,
  p_user_phone text,
  p_replacements jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(title text, body text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lang text;
  v_title text;
  v_body text;
  k text;
  v text;
BEGIN
  v_lang := public.resolve_user_lang(p_user_phone);

  SELECT n.title, n.body
  INTO v_title, v_body
  FROM public.notification_i18n n
  WHERE n.copy_key = p_copy_key
    AND n.lang = v_lang;

  IF NOT FOUND THEN
    SELECT n.title, n.body
    INTO v_title, v_body
    FROM public.notification_i18n n
    WHERE n.copy_key = p_copy_key
      AND n.lang = 'en';
  END IF;

  v_title := COALESCE(v_title, '');
  v_body := COALESCE(v_body, '');

  IF p_replacements IS NOT NULL AND p_replacements <> '{}'::jsonb THEN
    FOR k, v IN
      SELECT * FROM jsonb_each_text(p_replacements)
    LOOP
      v_title := replace(v_title, '{' || k || '}', COALESCE(v, ''));
      v_body := replace(v_body, '{' || k || '}', COALESCE(v, ''));
    END LOOP;
  END IF;

  title := v_title;
  body := v_body;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.notification_i18n_format(text, text, jsonb) IS
  'Resolves localized title/body for a copy_key (lang with en fallback) and replaces {key} placeholders.';

GRANT EXECUTE ON FUNCTION public.resolve_user_lang(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_i18n_format(text, text, jsonb) TO anon, authenticated;

INSERT INTO public.notification_i18n (copy_key, lang, title, body) VALUES
  -- order_expired
  ('order_expired', 'en',
   'Order Expired',
   'No vendor accepted your request in time. Please try again.'),
  ('order_expired', 'hi',
   'ऑर्डर समाप्त',
   'समय पर किसी भी विक्रेता ने आपका अनुरोध स्वीकार नहीं किया। कृपया फिर से प्रयास करें।'),
  ('order_expired', 'mr',
   'ऑर्डर कालबाह्य',
   'वेळेत कोणत्याही विक्रेत्याने तुमची विनंती स्वीकारली नाही. कृपया पुन्हा प्रयत्न करा.'),

  -- order_expired_delivery
  ('order_expired_delivery', 'en',
   'Order Expired',
   'No vendor accepted your request for the {slot} in time. Please try again.'),
  ('order_expired_delivery', 'hi',
   'ऑर्डर समाप्त',
   'समय पर किसी भी विक्रेता ने आपके {slot} का अनुरोध स्वीकार नहीं किया। कृपया फिर से प्रयास करें।'),
  ('order_expired_delivery', 'mr',
   'ऑर्डर कालबाह्य',
   'वेळेत कोणत्याही विक्रेत्याने तुमच्या {slot} साठीची विनंती स्वीकारली नाही. कृपया पुन्हा प्रयत्न करा.'),

  -- order_expired_appointment
  ('order_expired_appointment', 'en',
   'Order Expired',
   'Your vendor did not confirm your booking for {when} in time.'),
  ('order_expired_appointment', 'hi',
   'ऑर्डर समाप्त',
   'आपके विक्रेता ने {when} की बुकिंग समय पर पुष्टि नहीं की।'),
  ('order_expired_appointment', 'mr',
   'ऑर्डर कालबाह्य',
   'तुमच्या विक्रेत्याने {when} ची बुकिंग वेळेत पुष्टी केली नाही.'),

  -- near_deadline_delivery_unseen
  ('near_deadline_delivery_unseen', 'en',
   'Delivery window soon',
   'Your vendor has not seen your {slot} order yet. The delivery window is closing soon.'),
  ('near_deadline_delivery_unseen', 'hi',
   'डिलीवरी समय सीमा निकट',
   'आपके विक्रेता ने अभी तक आपका {slot} ऑर्डर नहीं देखा है। डिलीवरी की समय सीमा जल्द बंद हो रही है।'),
  ('near_deadline_delivery_unseen', 'mr',
   'डिलिव्हरी वेळ जवळ आली',
   'तुमच्या विक्रेत्याने अद्याप तुमचा {slot} ऑर्डर पाहिलेला नाही. डिलिव्हरीची वेळ लवकरच संपणार आहे.'),

  -- near_deadline_delivery_unconfirmed
  ('near_deadline_delivery_unconfirmed', 'en',
   'Delivery window soon',
   'Your vendor saw your {slot} order but has not accepted it. The delivery window is closing soon.'),
  ('near_deadline_delivery_unconfirmed', 'hi',
   'डिलीवरी समय सीमा निकट',
   'आपके विक्रेता ने आपका {slot} ऑर्डर देखा है, लेकिन स्वीकार नहीं किया। डिलीवरी की समय सीमा जल्द बंद हो रही है।'),
  ('near_deadline_delivery_unconfirmed', 'mr',
   'डिलिव्हरी वेळ जवळ आली',
   'तुमच्या विक्रेत्याने तुमचा {slot} ऑर्डर पाहिला आहे, पण स्वीकारलेला नाही. डिलिव्हरीची वेळ लवकरच संपणार आहे.'),

  -- near_deadline_appointment_unseen
  ('near_deadline_appointment_unseen', 'en',
   'Appointment reminder',
   'Your vendor has not seen your booking for {when} yet. Appointment time is approaching.'),
  ('near_deadline_appointment_unseen', 'hi',
   'अपॉइंटमेंट अनुस्मारक',
   'आपके विक्रेता ने अभी तक {when} की आपकी बुकिंग नहीं देखी है। अपॉइंटमेंट का समय निकट आ रहा है।'),
  ('near_deadline_appointment_unseen', 'mr',
   'अपॉइंटमेंट स्मरण',
   'तुमच्या विक्रेत्याने अद्याप {when} ची तुमची बुकिंग पाहिलेली नाही. अपॉइंटमेंटची वेळ जवळ येत आहे.'),

  -- near_deadline_appointment_unconfirmed
  ('near_deadline_appointment_unconfirmed', 'en',
   'Appointment reminder',
   'Your vendor has not confirmed your booking for {when}. Appointment time is approaching.'),
  ('near_deadline_appointment_unconfirmed', 'hi',
   'अपॉइंटमेंट अनुस्मारक',
   'आपके विक्रेता ने {when} की आपकी बुकिंग की पुष्टि नहीं की है। अपॉइंटमेंट का समय निकट आ रहा है।'),
  ('near_deadline_appointment_unconfirmed', 'mr',
   'अपॉइंटमेंट स्मरण',
   'तुमच्या विक्रेत्याने {when} ची तुमची बुकिंग पुष्टी केलेली नाही. अपॉइंटमेंटची वेळ जवळ येत आहे.'),

  -- near_deadline_help_unseen
  ('near_deadline_help_unseen', 'en',
   'Order response needed',
   'Your vendor has not accepted your order yet. Time is running out.'),
  ('near_deadline_help_unseen', 'hi',
   'ऑर्डर का जवाब आवश्यक',
   'आपके विक्रेता ने अभी तक आपका ऑर्डर स्वीकार नहीं किया है। समय समाप्त हो रहा है।'),
  ('near_deadline_help_unseen', 'mr',
   'ऑर्डर प्रतिसाद आवश्यक',
   'तुमच्या विक्रेत्याने अद्याप तुमचा ऑर्डर स्वीकारलेला नाही. वेळ संपत आहे.'),

  -- vendor_offline_active
  ('vendor_offline_active', 'en',
   'Your vendor has gone offline',
   'Your order may be affected. Please find another vendor if needed.'),
  ('vendor_offline_active', 'hi',
   'आपका विक्रेता ऑफ़लाइन हो गया है',
   'आपके ऑर्डर पर असर पड़ सकता है। ज़रूरत हो तो कृपया दूसरा विक्रेता खोजें।'),
  ('vendor_offline_active', 'mr',
   'तुमचा विक्रेता ऑफलाइन झाला आहे',
   'तुमच्या ऑर्डरवर परिणाम होऊ शकतो. गरज असल्यास कृपया दुसरा विक्रेता शोधा.'),

  -- vendor_offline_pending
  ('vendor_offline_pending', 'en',
   'Vendor has gone offline',
   'Your vendor has gone offline. You can cancel this order and place a new one, or wait for them to come back online.'),
  ('vendor_offline_pending', 'hi',
   'विक्रेता ऑफ़लाइन हो गया है',
   'आपका विक्रेता ऑफ़लाइन हो गया है। आप इस ऑर्डर को रद्द करके नया ऑर्डर दे सकते हैं, या उनके वापस ऑनलाइन आने की प्रतीक्षा कर सकते हैं।'),
  ('vendor_offline_pending', 'mr',
   'विक्रेता ऑफलाइन झाला आहे',
   'तुमचा विक्रेता ऑफलाइन झाला आहे. तुम्ही हा ऑर्डर रद्द करून नवीन देऊ शकता, किंवा ते पुन्हा ऑनलाइन येईपर्यंत प्रतीक्षा करू शकता.'),

  -- feed copy (title matters; body empty)
  ('feed_announcement', 'en', 'New announcement', ''),
  ('feed_announcement', 'hi', 'नई घोषणा', ''),
  ('feed_announcement', 'mr', 'नवीन घोषणा', ''),
  ('feed_recommendation', 'en', 'New recommendation', ''),
  ('feed_recommendation', 'hi', 'नई सिफ़ारिश', ''),
  ('feed_recommendation', 'mr', 'नवीन शिफारस', ''),
  ('feed_offer', 'en', 'New offer', ''),
  ('feed_offer', 'hi', 'नई पेशकश', ''),
  ('feed_offer', 'mr', 'नवीन ऑफर', '')
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

-- ============================================================================
-- C. Rewrite warn_pending_orders_near_deadline (i18n titles/bodies)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.warn_pending_orders_near_deadline()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  help_accept_timeout_minutes integer;
  delivery_near_deadline_minutes integer;
  appointment_near_deadline_minutes integer;
  help_near_deadline_minutes integer;
BEGIN
  SELECT NULLIF(trim(value), '')::integer
  INTO help_accept_timeout_minutes
  FROM public.app_config
  WHERE key = 'help_accept_timeout_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO delivery_near_deadline_minutes
  FROM public.app_config
  WHERE key = 'delivery_near_deadline_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO appointment_near_deadline_minutes
  FROM public.app_config
  WHERE key = 'appointment_near_deadline_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO help_near_deadline_minutes
  FROM public.app_config
  WHERE key = 'help_near_deadline_minutes';

  IF help_accept_timeout_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key help_accept_timeout_minutes is missing or invalid';
  END IF;

  IF delivery_near_deadline_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key delivery_near_deadline_minutes is missing or invalid';
  END IF;

  IF appointment_near_deadline_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key appointment_near_deadline_minutes is missing or invalid';
  END IF;

  IF help_near_deadline_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key help_near_deadline_minutes is missing or invalid';
  END IF;

  -- Delivery: vendor has not opened the order (sent)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'delivery'
      AND r.status = 'sent'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = g.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'delivery'
      AND r.status = 'sent'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
    RETURNING r.id, r.user_phone, r.vendor_id, r.delivery_slot
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      delivery_slot
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
  INSERT INTO public.user_notifications (
    user_phone,
    type,
    title,
    body,
    route,
    route_params,
    related_id,
    is_informational
  )
  SELECT
    rep.user_phone,
    'order_near_deadline_unseen',
    (SELECT f.title FROM public.notification_i18n_format(
      'near_deadline_delivery_unseen',
      rep.user_phone,
      jsonb_build_object('slot', COALESCE(rep.delivery_slot, 'delivery'))
    ) f),
    (SELECT f.body FROM public.notification_i18n_format(
      'near_deadline_delivery_unseen',
      rep.user_phone,
      jsonb_build_object('slot', COALESCE(rep.delivery_slot, 'delivery'))
    ) f),
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Delivery: vendor saw but has not accepted (seen)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'delivery'
      AND r.status = 'seen'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = g.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'delivery'
      AND r.status = 'seen'
      AND r.delivery_slot_deadline IS NOT NULL
      AND now() >= r.delivery_slot_deadline
        - (delivery_near_deadline_minutes || ' minutes')::interval
      AND now() < r.delivery_slot_deadline
    RETURNING r.id, r.user_phone, r.vendor_id, r.delivery_slot
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      delivery_slot
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
  INSERT INTO public.user_notifications (
    user_phone,
    type,
    title,
    body,
    route,
    route_params,
    related_id,
    is_informational
  )
  SELECT
    rep.user_phone,
    'order_near_deadline_unconfirmed',
    (SELECT f.title FROM public.notification_i18n_format(
      'near_deadline_delivery_unconfirmed',
      rep.user_phone,
      jsonb_build_object('slot', COALESCE(rep.delivery_slot, 'delivery'))
    ) f),
    (SELECT f.body FROM public.notification_i18n_format(
      'near_deadline_delivery_unconfirmed',
      rep.user_phone,
      jsonb_build_object('slot', COALESCE(rep.delivery_slot, 'delivery'))
    ) f),
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Appointment / booking: vendor has not opened the request (sent + pending)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'appointment'
      AND r.status = 'sent'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = g.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'appointment'
      AND r.status = 'sent'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
    RETURNING r.id, r.user_phone, r.vendor_id, r.appointment_time
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      appointment_time
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
  INSERT INTO public.user_notifications (
    user_phone,
    type,
    title,
    body,
    route,
    route_params,
    related_id,
    is_informational
  )
  SELECT
    rep.user_phone,
    'order_near_deadline_unseen',
    (SELECT f.title FROM public.notification_i18n_format(
      'near_deadline_appointment_unseen',
      rep.user_phone,
      jsonb_build_object(
        'when',
        COALESCE(
          TO_CHAR(rep.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
          'your appointment'
        )
      )
    ) f),
    (SELECT f.body FROM public.notification_i18n_format(
      'near_deadline_appointment_unseen',
      rep.user_phone,
      jsonb_build_object(
        'when',
        COALESCE(
          TO_CHAR(rep.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
          'your appointment'
        )
      )
    ) f),
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Appointment / booking: vendor saw but has not confirmed (seen + pending)
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'appointment'
      AND r.status = 'seen'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = g.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'appointment'
      AND r.status = 'seen'
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND now() >= r.appointment_time
        - (appointment_near_deadline_minutes || ' minutes')::interval
      AND now() < r.appointment_time
    RETURNING r.id, r.user_phone, r.vendor_id, r.appointment_time
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id,
      appointment_time
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
  INSERT INTO public.user_notifications (
    user_phone,
    type,
    title,
    body,
    route,
    route_params,
    related_id,
    is_informational
  )
  SELECT
    rep.user_phone,
    'order_near_deadline_unconfirmed',
    (SELECT f.title FROM public.notification_i18n_format(
      'near_deadline_appointment_unconfirmed',
      rep.user_phone,
      jsonb_build_object(
        'when',
        COALESCE(
          TO_CHAR(rep.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
          'your appointment'
        )
      )
    ) f),
    (SELECT f.body FROM public.notification_i18n_format(
      'near_deadline_appointment_unconfirmed',
      rep.user_phone,
      jsonb_build_object(
        'when',
        COALESCE(
          TO_CHAR(rep.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
          'your appointment'
        )
      )
    ) f),
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;

  -- Help: vendor has not accepted before the accept timeout
  WITH groups AS (
    SELECT DISTINCT r.user_phone, r.vendor_id
    FROM public.requests r
    INNER JOIN public.vendors v ON r.vendor_id = v.id
    WHERE v.service_mode = 'help'
      AND r.status = 'sent'
      AND now() >= r.created_at
        + (help_accept_timeout_minutes || ' minutes')::interval
        - (help_near_deadline_minutes || ' minutes')::interval
      AND now() < r.created_at + (help_accept_timeout_minutes || ' minutes')::interval
      AND r.user_phone IS NOT NULL
      AND trim(r.user_phone) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.requests r2
        WHERE r2.user_phone = r.user_phone
          AND r2.vendor_id = r.vendor_id
          AND r2.near_deadline_warned_at IS NOT NULL
      )
  ),
  marked AS (
    UPDATE public.requests r
    SET
      near_deadline_warned_at = now(),
      near_deadline_push_sent = false
    FROM groups g
    INNER JOIN public.vendors v ON v.id = g.vendor_id
    WHERE r.user_phone = g.user_phone
      AND r.vendor_id = g.vendor_id
      AND r.near_deadline_warned_at IS NULL
      AND v.service_mode = 'help'
      AND r.status = 'sent'
      AND now() >= r.created_at
        + (help_accept_timeout_minutes || ' minutes')::interval
        - (help_near_deadline_minutes || ' minutes')::interval
      AND now() < r.created_at + (help_accept_timeout_minutes || ' minutes')::interval
    RETURNING r.id, r.user_phone, r.vendor_id
  ),
  representatives AS (
    SELECT DISTINCT ON (user_phone, vendor_id)
      id,
      user_phone,
      vendor_id
    FROM marked
    ORDER BY user_phone, vendor_id, id
  )
  INSERT INTO public.user_notifications (
    user_phone,
    type,
    title,
    body,
    route,
    route_params,
    related_id,
    is_informational
  )
  SELECT
    rep.user_phone,
    'order_near_deadline_unseen',
    (SELECT f.title FROM public.notification_i18n_format(
      'near_deadline_help_unseen',
      rep.user_phone
    ) f),
    (SELECT f.body FROM public.notification_i18n_format(
      'near_deadline_help_unseen',
      rep.user_phone
    ) f),
    'my-orders',
    jsonb_build_object('order_id', rep.id),
    rep.id,
    false
  FROM representatives rep;
END;
$$;

COMMENT ON FUNCTION public.warn_pending_orders_near_deadline() IS
  'Warns customers once per vendor when expected time is near and the vendor has not committed (inbox; push via warn-near-deadline edge function). Localized via notification_i18n.';

-- ============================================================================
-- D. Rewrite expire_pending_orders (i18n + skip_inbox on FCM post)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.expire_pending_orders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $expire$
DECLARE
  help_accept_timeout_minutes integer;
  appointment_accept_timeout_hours integer;
  notify_url text;
  notify_anon_key text;
  rec record;
BEGIN
  SELECT NULLIF(trim(value), '')
  INTO notify_url
  FROM public.app_config
  WHERE key = 'edge_function_url';

  SELECT NULLIF(trim(value), '')
  INTO notify_anon_key
  FROM public.app_config
  WHERE key = 'anon_key';

  IF notify_url IS NULL THEN
    RAISE EXCEPTION 'app_config key edge_function_url is missing or invalid';
  END IF;

  IF notify_anon_key IS NULL THEN
    RAISE EXCEPTION 'app_config key anon_key is missing or invalid';
  END IF;

  notify_url := notify_url || '/notify-user';

  PERFORM public.warn_pending_orders_near_deadline();

  CREATE TEMP TABLE IF NOT EXISTS _expire_push_phones (
    user_phone text PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE _expire_push_phones;

  -- Drop if present so a prior session shape (notify_body) cannot conflict.
  DROP TABLE IF EXISTS _expired_for_notify;
  CREATE TEMP TABLE _expired_for_notify (
    request_id uuid PRIMARY KEY,
    user_phone text NOT NULL,
    copy_key text NOT NULL,
    replacements jsonb NOT NULL DEFAULT '{}'::jsonb
  ) ON COMMIT DROP;

  SELECT NULLIF(trim(value), '')::integer
  INTO help_accept_timeout_minutes
  FROM public.app_config
  WHERE key = 'help_accept_timeout_minutes';

  SELECT NULLIF(trim(value), '')::integer
  INTO appointment_accept_timeout_hours
  FROM public.app_config
  WHERE key = 'appointment_accept_timeout_hours';

  IF help_accept_timeout_minutes IS NULL THEN
    RAISE EXCEPTION 'app_config key help_accept_timeout_minutes is missing or invalid';
  END IF;

  IF appointment_accept_timeout_hours IS NULL THEN
    RAISE EXCEPTION 'app_config key appointment_accept_timeout_hours is missing or invalid';
  END IF;

  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'help'
      AND r.status = 'sent'
      AND r.created_at + (help_accept_timeout_minutes || ' minutes')::interval < now()
    RETURNING r.id, r.user_phone
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, copy_key, replacements)
  SELECT e.id, trim(e.user_phone), 'order_expired', '{}'::jsonb
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH expired AS (
    UPDATE public.requests r
    SET status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'delivery'
      AND r.status IN ('sent', 'seen')
      AND r.delivery_slot_deadline IS NOT NULL
      AND r.delivery_slot_deadline < now()
    RETURNING r.id, r.user_phone, r.delivery_slot
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, copy_key, replacements)
  SELECT
    e.id,
    trim(e.user_phone),
    'order_expired_delivery',
    jsonb_build_object(
      'slot',
      CASE COALESCE(e.delivery_slot, '')
        WHEN 'morning' THEN 'morning slot'
        WHEN 'evening' THEN 'evening slot'
        WHEN 'night' THEN 'night slot'
        ELSE 'your delivery slot'
      END
    )
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH expired AS (
    UPDATE public.requests r
    SET
      status = 'expired',
      appointment_status = 'expired'
    FROM public.vendors v
    WHERE r.vendor_id = v.id
      AND v.service_mode = 'appointment'
      AND r.status IN ('sent', 'seen')
      AND r.appointment_status = 'pending'
      AND r.appointment_time IS NOT NULL
      AND r.appointment_time < now()
    RETURNING r.id, r.user_phone, r.appointment_time
  )
  INSERT INTO _expired_for_notify (request_id, user_phone, copy_key, replacements)
  SELECT
    e.id,
    trim(e.user_phone),
    'order_expired_appointment',
    jsonb_build_object(
      'when',
      COALESCE(
        TO_CHAR(e.appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
        ''
      )
    )
  FROM expired e
  WHERE e.user_phone IS NOT NULL AND trim(e.user_phone) <> '';

  WITH reps AS (
    SELECT DISTINCT ON (user_phone)
      request_id,
      user_phone,
      copy_key,
      replacements
    FROM _expired_for_notify
    ORDER BY user_phone, request_id
  ),
  inserted AS (
    INSERT INTO public.user_notifications (
      user_phone,
      type,
      title,
      body,
      route,
      route_params,
      related_id,
      is_informational
    )
    SELECT
      r.user_phone,
      'order_expired',
      (SELECT f.title FROM public.notification_i18n_format(r.copy_key, r.user_phone, r.replacements) f),
      (SELECT f.body FROM public.notification_i18n_format(r.copy_key, r.user_phone, r.replacements) f),
      'my-orders',
      jsonb_build_object('order_id', r.request_id),
      r.request_id,
      false
    FROM reps r
    RETURNING user_phone
  )
  INSERT INTO _expire_push_phones (user_phone)
  SELECT DISTINCT trim(user_phone)
  FROM inserted
  ON CONFLICT (user_phone) DO NOTHING;

  FOR rec IN
    SELECT DISTINCT ON (user_phone)
      user_phone,
      copy_key,
      replacements
    FROM _expired_for_notify
    ORDER BY user_phone, request_id
  LOOP
    PERFORM net.http_post(
      url := notify_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || notify_anon_key
      ),
      body := jsonb_build_object(
        'user_phone', rec.user_phone,
        'title', (SELECT f.title FROM public.notification_i18n_format(rec.copy_key, rec.user_phone, rec.replacements) f),
        'body', (SELECT f.body FROM public.notification_i18n_format(rec.copy_key, rec.user_phone, rec.replacements) f),
        'type', 'order_expired',
        'route', 'my-orders',
        'skip_inbox', true
      )
    );
  END LOOP;
END;
$expire$;

COMMENT ON FUNCTION public.expire_pending_orders() IS
  'Expires overdue help/delivery/appointment requests, writes localized inbox notices, and FCM-notifies with skip_inbox.';

-- ============================================================================
-- E. Rewrite notify_vendor_offline_orders (i18n)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_vendor_offline_orders(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      id,
      user_phone,
      status,
      appointment_status,
      delivery_slot,
      appointment_time
    FROM public.requests
    WHERE vendor_id = p_vendor_id
      AND status IN ('sent', 'seen', 'accepted')
  LOOP
    IF r.user_phone IS NULL OR btrim(r.user_phone) = '' THEN
      CONTINUE;
    END IF;

    IF public._order_should_notify_vendor_offline(r.status, r.appointment_status) THEN
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
        r.user_phone,
        'order_update',
        (SELECT f.title FROM public.notification_i18n_format('vendor_offline_active', r.user_phone) f),
        (SELECT f.body FROM public.notification_i18n_format('vendor_offline_active', r.user_phone) f),
        'my-orders',
        jsonb_build_object('order_id', r.id),
        r.id,
        false,
        false
      );
    ELSIF public._order_should_notify_pending_vendor_offline(
      r.status,
      r.appointment_status,
      r.delivery_slot,
      r.appointment_time
    ) THEN
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
        r.user_phone,
        'order_update',
        (SELECT f.title FROM public.notification_i18n_format('vendor_offline_pending', r.user_phone) f),
        (SELECT f.body FROM public.notification_i18n_format('vendor_offline_pending', r.user_phone) f),
        'my-orders',
        jsonb_build_object('order_id', r.id),
        r.id,
        false,
        false
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.notify_vendor_offline_orders(uuid) IS
  'Notifies customers of affected active/pending orders when a vendor goes offline. Localized via notification_i18n.';

-- ============================================================================
-- F. Rewrite create_customer_request (offline notice i18n; no slot constraint)
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
  p_category_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_active boolean;
  v_category_id uuid;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT v.is_active
  INTO v_vendor_active
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF lower(btrim(coalesce(p_delivery_slot, ''))) = 'asap' AND v_vendor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'vendor_not_live_for_asap';
  END IF;

  IF p_appointment_instant IS TRUE AND v_vendor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'vendor_not_live_for_instant';
  END IF;

  -- Prefer client-supplied matched category when it belongs to this vendor;
  -- otherwise fall back to primary approved category, then vendors.category label.
  IF p_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
      AND vc.status = 'approved'
  ) THEN
    v_category_id := p_category_id;
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      SELECT c.id
      INTO v_category_id
      FROM public.vendors v
      JOIN public.categories c ON c.label = v.category
      WHERE v.id = p_vendor_id
      LIMIT 1;
    END IF;
  END IF;

  INSERT INTO public.requests (
    device_id,
    vendor_id,
    message,
    status,
    user_phone,
    device_id_log,
    delivery_address,
    delivery_slot,
    delivery_slot_deadline,
    appointment_time,
    appointment_status,
    customer_latitude,
    customer_longitude,
    category_id
  )
  VALUES (
    p_device_id,
    p_vendor_id,
    p_message,
    'sent',
    p_user_phone,
    p_device_id_log,
    p_delivery_address,
    p_delivery_slot,
    p_delivery_slot_deadline,
    p_appointment_time,
    p_appointment_status,
    p_customer_latitude,
    p_customer_longitude,
    v_category_id
  )
  RETURNING id INTO v_id;

  IF v_vendor_active IS NOT TRUE
    AND p_user_phone IS NOT NULL
    AND btrim(p_user_phone) <> ''
  THEN
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
      p_user_phone,
      'order_update',
      (SELECT f.title FROM public.notification_i18n_format('vendor_offline_pending', p_user_phone) f),
      (SELECT f.body FROM public.notification_i18n_format('vendor_offline_pending', p_user_phone) f),
      'my-orders',
      jsonb_build_object('order_id', v_id),
      v_id,
      false,
      false
    );
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision, boolean, uuid
) TO anon, authenticated;

-- ============================================================================
-- G. Archival — also delete unread notifications older than 180 days
-- ============================================================================

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'archive-old-data';

SELECT cron.schedule(
  'archive-old-data',
  '0 2 1 * *',
  $$
    DELETE FROM public.requests
    WHERE created_at < now() - interval '180 days'
      AND status IN ('cancelled', 'expired', 'fulfilled');

    DELETE FROM public.user_notifications
    WHERE created_at < now() - interval '90 days'
      AND is_read = true;

    DELETE FROM public.user_notifications
    WHERE created_at < now() - interval '180 days'
      AND is_read = false;

    DELETE FROM public.fcm_delivery_log
    WHERE created_at < now() - interval '90 days';

    DELETE FROM public._test_otp_capture
    WHERE created_at < now() - interval '7 days';
  $$
);

-- ============================================================================
-- H. Admin FCM stats RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_admin_fcm_failure_stats(p_hours integer DEFAULT 24)
RETURNS TABLE(
  notification_type text,
  failure_events bigint,
  success_events bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session()
     AND coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT
    l.notification_type,
    count(*) FILTER (WHERE l.failure_count > 0) AS failure_events,
    count(*) FILTER (WHERE l.success_count > 0 AND l.failure_count = 0) AS success_events
  FROM public.fcm_delivery_log l
  WHERE l.created_at >= now() - (p_hours || ' hours')::interval
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$$;

COMMENT ON FUNCTION public.get_admin_fcm_failure_stats(integer) IS
  'Admin-only FCM delivery failure/success counts by notification_type over the last p_hours.';

GRANT EXECUTE ON FUNCTION public.get_admin_fcm_failure_stats(integer) TO authenticated, anon;
