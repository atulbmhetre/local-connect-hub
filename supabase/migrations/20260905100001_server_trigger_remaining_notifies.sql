-- Session 42B: move remaining production client invokeNotify* calls to DB triggers.
-- Shared helpers + AFTER INSERT/UPDATE triggers. Inbox when applicable; FCM via pg_net
-- with skip_inbox when inbox already written. Admin-gated notifies use service_role_key.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ── Shared helpers ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._edge_notify_keys(
  OUT edge_url text,
  OUT anon_key text,
  OUT service_role_key text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  SELECT value INTO edge_url FROM public.app_config WHERE key = 'edge_function_url';
  SELECT value INTO anon_key FROM public.app_config WHERE key = 'anon_key';
  SELECT value INTO service_role_key FROM public.app_config WHERE key = 'service_role_key';
  edge_url := NULLIF(btrim(COALESCE(edge_url, '')), '');
  anon_key := NULLIF(btrim(COALESCE(anon_key, '')), '');
  service_role_key := NULLIF(btrim(COALESCE(service_role_key, '')), '');
END;
$$;

COMMENT ON FUNCTION public._edge_notify_keys() IS
  'Returns edge_function_url + anon_key + service_role_key from app_config (trimmed, null if empty).';

CREATE OR REPLACE FUNCTION public._pg_net_notify_user(
  p_body jsonb,
  p_use_service_role boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_url text;
  v_anon text;
  v_sr text;
  v_key text;
BEGIN
  SELECT edge_url, anon_key, service_role_key INTO v_url, v_anon, v_sr
  FROM public._edge_notify_keys();
  v_key := CASE WHEN p_use_service_role THEN v_sr ELSE v_anon END;
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/notify-user',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := p_body
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._pg_net_notify_vendor(
  p_body jsonb,
  p_use_service_role boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_url text;
  v_anon text;
  v_sr text;
  v_key text;
BEGIN
  SELECT edge_url, anon_key, service_role_key INTO v_url, v_anon, v_sr
  FROM public._edge_notify_keys();
  v_key := CASE WHEN p_use_service_role THEN v_sr ELSE v_anon END;
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/notify-vendor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := p_body
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._pg_net_notify_admin(
  p_title text,
  p_body text,
  p_type text,
  p_route text DEFAULT 'settings',
  p_route_params jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_url text;
  v_anon text;
  v_sr text;
BEGIN
  SELECT edge_url, anon_key, service_role_key INTO v_url, v_anon, v_sr
  FROM public._edge_notify_keys();
  IF v_url IS NULL OR COALESCE(v_sr, v_anon) IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/notify-admin',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_sr, v_anon)
    ),
    body := jsonb_build_object(
      'title', p_title,
      'body', p_body,
      'type', p_type,
      'route', p_route,
      'route_params', COALESCE(p_route_params, '{}'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public._edge_notify_keys() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._pg_net_notify_user(jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._pg_net_notify_vendor(jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._pg_net_notify_admin(text, text, text, text, jsonb) FROM PUBLIC;

-- ── i18n seeds ───────────────────────────────────────────────────────────────

INSERT INTO public.notification_i18n (copy_key, lang, title, body) VALUES
  ('referral_credit', 'en', 'Referral bonus earned!', 'Someone joined Aaspaas using your referral. ₹{amount} credit added to your account.'),
  ('referral_credit', 'hi', 'रेफरल बोनस मिला!', 'किसी ने आपके रेफरल से Aaspaas जॉइन किया। आपके खाते में ₹{amount} क्रेडिट जोड़ा गया।'),
  ('referral_credit', 'mr', 'रेफरल बोनस मिळाला!', 'कोणीतरी तुमच्या रेफरलने Aaspaas जॉइन केले. तुमच्या खात्यात ₹{amount} क्रेडिट जोडले.'),

  ('account_warning', 'en', '⚠️ Account Warning', 'Your account has received complaints from vendors. Further issues may result in suspension.'),
  ('account_warning', 'hi', '⚠️ खाता चेतावनी', 'आपके खाते पर विक्रेताओं की शिकायतें आई हैं। आगे समस्याएं होने पर खाता निलंबित हो सकता है।'),
  ('account_warning', 'mr', '⚠️ खाते इशारा', 'तुमच्या खात्यावर विक्रेत्यांच्या तक्रारी आल्या आहेत. पुढील समस्यांमुळे खाते निलंबित होऊ शकते.'),

  ('account_banned_user', 'en', 'Account Suspended', 'Your account has been suspended due to complaints. Contact support.'),
  ('account_banned_user', 'hi', 'खाता निलंबित', 'शिकायतों के कारण आपका खाता निलंबित कर दिया गया है। सहायता से संपर्क करें।'),
  ('account_banned_user', 'mr', 'खाते निलंबित', 'तक्रारींमुळे तुमचे खाते निलंबित केले आहे. सपोर्टशी संपर्क करा.'),

  ('account_banned_vendor', 'en', 'Account Suspended', 'Your vendor account has been suspended. Contact support.'),
  ('account_banned_vendor', 'hi', 'खाता निलंबित', 'आपका विक्रेता खाता निलंबित कर दिया गया है। सहायता से संपर्क करें।'),
  ('account_banned_vendor', 'mr', 'खाते निलंबित', 'तुमचे विक्रेता खाते निलंबित केले आहे. सपोर्टशी संपर्क करा.'),

  ('account_restored', 'en', 'Account Restored', 'Your account has been restored. Welcome back!'),
  ('account_restored', 'hi', 'खाता पुनर्स्थापित', 'आपका खाता पुनर्स्थापित किया गया है। वापसी पर स्वागत है!'),
  ('account_restored', 'mr', 'खाते पुनर्स्थापित', 'तुमचे खाते पुनर्स्थापित केले आहे. परत स्वागत आहे!'),

  ('subscription_update', 'en', 'Special offer for you!', 'Aaspaas Pro is offering you {percent}% off for {months} months. Offer applied automatically on your next billing.'),
  ('subscription_update', 'hi', 'आपके लिए खास ऑफर!', 'Aaspaas Pro आपको {months} महीनों के लिए {percent}% छूट दे रहा है। ऑफर आपके अगले बिल पर अपने आप लागू होगा।'),
  ('subscription_update', 'mr', 'तुमच्यासाठी खास ऑफर!', 'Aaspaas Pro तुम्हाला {months} महिन्यांसाठी {percent}% सूट देत आहे. ऑफर तुमच्या पुढील बिलिंगवर आपोआप लागू होईल.'),

  ('vendor_green_ready', 'en', 'Vendor ready for verification', '{shop} has completed all verification steps. Review and approve.'),
  ('vendor_green_ready', 'hi', 'विक्रेता सत्यापन के लिए तैयार', '{shop} ने सभी सत्यापन चरण पूरे कर लिए हैं। समीक्षा कर स्वीकृत करें।'),
  ('vendor_green_ready', 'mr', 'विक्रेता पडताळणीसाठी तयार', '{shop} ने सर्व पडताळणी चरण पूर्ण केले आहेत. समीक्षा करून मंजूर करा.'),

  ('new_vendor', 'en', '🏪 New vendor registered', '{shop} — {category} ({mode})'),
  ('new_vendor', 'hi', '🏪 नया दुकानदार रजिस्टर हुआ', '{shop} — {category} ({mode})'),
  ('new_vendor', 'mr', '🏪 नवीन विक्रेता नोंदणी झाली', '{shop} — {category} ({mode})'),

  ('vendor_edited', 'en', '✏️ Vendor edited verified identity fields', '{shop} — phone'),
  ('vendor_edited', 'hi', '✏️ विक्रेता ने सत्यापित पहचान फ़ील्ड बदले', '{shop} — phone'),
  ('vendor_edited', 'mr', '✏️ विक्रेत्याने पडताळलेली ओळख फील्ड बदलली', '{shop} — phone'),

  ('category_approved', 'en', 'Category Approved!', 'Your suggested category ''{label}'' has been approved!'),
  ('category_approved', 'hi', 'श्रेणी स्वीकृत!', 'आपकी सुझाई गई श्रेणी ''{label}'' अब AasPaas Pro पर लाइव है।'),
  ('category_approved', 'mr', 'श्रेणी मंजूर!', 'तुम्ही सुचवलेली ''{label}'' श्रेणी आता AasPaas Pro वर लाइव आहे.'),

  ('category_rejected', 'en', 'Category Not Approved', 'Your suggested category ''{label}'' was not approved at this time.'),
  ('category_rejected', 'hi', 'श्रेणी अस्वीकृत', 'आपकी सुझाई गई श्रेणी ''{label}'' इस समय स्वीकृत नहीं हुई।'),
  ('category_rejected', 'mr', 'श्रेणी नामंजूर', 'तुम्ही सुचवलेली ''{label}'' श्रेणी सध्या मंजूर झाली नाही.'),

  ('account_verified', 'en', 'You''re verified!', 'Congratulations! Your shop is now a Verified Professional on AasPaas Pro.'),
  ('account_verified', 'hi', 'आप सत्यापित हैं!', 'बधाई हो! आपकी दुकान अब AasPaas Pro पर सत्यापित प्रोफेशनल है।'),
  ('account_verified', 'mr', 'तुम्ही पडताळलेले आहात!', 'अभिनंदन! तुमचे दुकान आता AasPaas Pro वर पडताळलेले प्रोफेशनल आहे.'),

  ('order_accepted_help', 'en', 'Help is on the way!', 'Vendor accepted and is heading to you'),
  ('order_accepted_help', 'hi', 'मदद आ रही है!', 'विक्रेता ने स्वीकार किया और आ रहे हैं'),
  ('order_accepted_help', 'mr', 'मदत येत आहे!', 'विक्रेत्याने स्वीकारले आणि येत आहेत'),

  ('order_accepted_delivery', 'en', 'Order accepted', 'Your order has been accepted and is being prepared'),
  ('order_accepted_delivery', 'hi', 'ऑर्डर स्वीकार हो गया', 'आपका ऑर्डर स्वीकार हो गया है, तैयारी हो रही है'),
  ('order_accepted_delivery', 'mr', 'ऑर्डर स्वीकारला', 'तुमचा ऑर्डर स्वीकार झाला आहे, तयारी सुरू आहे'),

  ('order_fulfilled', 'en', 'Service completed', 'Your order has been marked as completed. Thank you!'),
  ('order_fulfilled', 'hi', 'सेवा पूर्ण हुई', 'आपका ऑर्डर पूरा कर दिया गया है। धन्यवाद!'),
  ('order_fulfilled', 'mr', 'सेवा पूर्ण झाली', 'तुमचा ऑर्डर पूर्ण म्हणून चिन्हांकित झाला. धन्यवाद!'),

  ('payment_confirmed', 'en', 'Payment Confirmed', 'Your payment of ₹{amount} has been confirmed by the vendor.'),
  ('payment_confirmed', 'hi', 'भुगतान की पुष्टि', 'विक्रेता ने आपके ₹{amount} के भुगतान की पुष्टि कर दी है।'),
  ('payment_confirmed', 'mr', 'पेमेंट पुष्टी', 'विक्रेत्याने तुमच्या ₹{amount} पेमेंटची पुष्टी केली आहे.'),

  ('payment_disputed', 'en', 'Payment Not Verified', 'Vendor could not verify your payment. Please recheck your UTR and resubmit.'),
  ('payment_disputed', 'hi', 'भुगतान सत्यापित नहीं हुआ', 'विक्रेता आपके भुगतान की पुष्टि नहीं कर सका। कृपया UTR जाँचकर फिर से भेजें।'),
  ('payment_disputed', 'mr', 'पेमेंट सत्यापित झाले नाही', 'विक्रेता तुमचे पेमेंट सत्यापित करू शकला नाही. कृपया UTR तपासून पुन्हा सबमिट करा.'),

  ('payment_claimed', 'en', 'Payment claimed — please confirm or dispute', 'Customer claims payment of ₹{amount} — UTR: {utr}'),
  ('payment_claimed', 'hi', 'भुगतान का दावा — कृपया पुष्टि करें या विवाद करें', 'ग्राहक ने ₹{amount} के भुगतान का दावा किया है — UTR: {utr}'),
  ('payment_claimed', 'mr', 'पेमेंट दावा — कृपया पुष्टी करा किंवा विवाद नोंदवा', 'ग्राहकाने ₹{amount} पेमेंट केल्याचा दावा केला आहे — UTR: {utr}'),

  ('appt_confirmed', 'en', 'Booking confirmed', 'Your booking has been confirmed. See you soon!'),
  ('appt_confirmed', 'hi', 'बुकिंग पक्की', 'आपकी बुकिंग पक्की हो गई। जल्द मिलते हैं!'),
  ('appt_confirmed', 'mr', 'बुकिंग निश्चित', 'तुमची बुकिंग निश्चित झाली. लवकर भेटू!'),

  ('appt_declined', 'en', 'Booking declined', 'Your booking was declined. Reason: {reason}'),
  ('appt_declined', 'hi', 'बुकिंग नकारी', 'आपकी बुकिंग नकारी गई। कारण: {reason}'),
  ('appt_declined', 'mr', 'बुकिंग नाकारली', 'तुमची बुकिंग नाकारली. कारण: {reason}'),

  ('order_cancelled_vendor', 'en', 'Order cancelled by vendor', 'Your order has been cancelled. Reason: {reason}'),
  ('order_cancelled_vendor', 'hi', 'विक्रेता ने ऑर्डर रद्द किया', 'आपका ऑर्डर रद्द कर दिया गया। कारण: {reason}'),
  ('order_cancelled_vendor', 'mr', 'विक्रेत्याने ऑर्डर रद्द केला', 'तुमचा ऑर्डर रद्द झाला. कारण: {reason}'),

  ('ive_started_delivery', 'en', 'Your delivery is on the way', 'Your vendor has started coming to you.'),
  ('ive_started_delivery', 'hi', 'आपका डिलीवरी आ रही है', 'आपके विक्रेता आपके पास आना शुरू कर चुके हैं।'),
  ('ive_started_delivery', 'mr', 'तुमची डिलिव्हरी येत आहे', 'तुमचे विक्रेते तुमच्याकडे येण्यास सुरुवात केली आहे.'),

  ('ive_started_help', 'en', 'Help is on the way', 'Your helper has started coming to you.'),
  ('ive_started_help', 'hi', 'मदद आ रही है', 'आपके सहायक आपके पास आना शुरू कर चुके हैं।'),
  ('ive_started_help', 'mr', 'मदत येत आहे', 'तुमचे मदतनीस तुमच्याकडे येण्यास सुरुवात केली आहे.'),

  ('ive_started_appointment', 'en', 'Your vendor is on the way', 'Your vendor has started coming to you.'),
  ('ive_started_appointment', 'hi', 'आपके विक्रेता आ रहे हैं', 'आपके विक्रेता आपके पास आना शुरू कर चुके हैं।'),
  ('ive_started_appointment', 'mr', 'तुमचे विक्रेते येत आहेत', 'तुमचे विक्रेते तुमच्याकडे येण्यास सुरुवात केली आहे.'),

  ('customer_cancelled', 'en', 'Order cancelled by customer', 'The customer has cancelled their order'),
  ('customer_cancelled', 'hi', 'ग्राहक ने ऑर्डर रद्द किया', 'ग्राहक ने अपना ऑर्डर रद्द कर दिया है'),
  ('customer_cancelled', 'mr', 'ग्राहकाने ऑर्डर रद्द केले', 'ग्राहकाने त्यांचा ऑर्डर रद्द केला आहे'),

  ('customer_dismissed', 'en', 'Customer marked order as done', 'The customer has marked this order as done on their end'),
  ('customer_dismissed', 'hi', 'ग्राहक ने ऑर्डर पूर्ण चिह्नित किया', 'ग्राहक ने अपनी ओर से इस ऑर्डर को पूर्ण चिह्नित कर दिया है'),
  ('customer_dismissed', 'mr', 'ग्राहकाने ऑर्डर पूर्ण म्हणून चिन्हांकित केले', 'ग्राहकाने त्यांच्या बाजूने हा ऑर्डर पूर्ण म्हणून चिन्हांकित केला आहे'),

  ('order_edited_same_day_appt', 'en', '⚠️ Customer edited today''s booking!', '{customer} changed their order — check details now'),
  ('order_edited_same_day_appt', 'hi', '⚠️ ग्राहक ने आज की बुकिंग बदली!', '{customer} ने ऑर्डर बदला — अभी विवरण देखें'),
  ('order_edited_same_day_appt', 'mr', '⚠️ ग्राहकाने आजची बुकिंग बदलली!', '{customer} ने ऑर्डर बदलला — आत्ता तपशील पाहा'),

  ('order_edited_appt', 'en', '✏️ Booking edited', '{customer} updated their booking details'),
  ('order_edited_appt', 'hi', '✏️ बुकिंग संपादित', '{customer} ने अपनी बुकिंग विवरण अपडेट किए'),
  ('order_edited_appt', 'mr', '✏️ बुकिंग संपादित', '{customer} ने त्यांचे बुकिंग तपशील अपडेट केले'),

  ('order_edited_same_day', 'en', '⚠️ Customer edited today''s order!', '{customer} changed their order — check details now'),
  ('order_edited_same_day', 'hi', '⚠️ ग्राहक ने आज का ऑर्डर बदला!', '{customer} ने ऑर्डर बदला — अभी विवरण देखें'),
  ('order_edited_same_day', 'mr', '⚠️ ग्राहकाने आजचा ऑर्डर बदलला!', '{customer} ने ऑर्डर बदलला — आत्ता तपशील पाहा'),

  ('order_edited', 'en', '✏️ Order edited', '{customer} updated their order details'),
  ('order_edited', 'hi', '✏️ ऑर्डर संपादित', '{customer} ने अपने ऑर्डर विवरण अपडेट किए'),
  ('order_edited', 'mr', '✏️ ऑर्डर संपादित', '{customer} ने त्यांचे ऑर्डर तपशील अपडेट केले'),

  ('review_low_rating', 'en', 'New Review', 'You received a low rating. Check your reviews in Settings.'),
  ('review_low_rating', 'hi', 'नई समीक्षा', 'आपको कम रेटिंग मिली। सेटिंग्स में अपनी समीक्षाएं देखें।'),
  ('review_low_rating', 'mr', 'नवीन समीक्षा', 'तुम्हाला कमी रेटिंग मिळाली. सेटिंग्समध्ये तुमच्या समीक्षा पाहा.'),

  ('khata_paid', 'en', 'Payment received', 'Your ledger has been cleared'),
  ('khata_paid', 'hi', 'भुगतान प्राप्त हुआ', 'आपका खाता साफ कर दिया गया है'),
  ('khata_paid', 'mr', 'पेमेंट मिळाले', 'तुमचे खाते साफ केले आहे')
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

CREATE OR REPLACE FUNCTION public._vendor_inbox_and_fcm(
  p_vendor_id uuid,
  p_title text,
  p_body text,
  p_type text,
  p_route text,
  p_route_params jsonb,
  p_related_id uuid,
  p_request_id uuid,
  p_referral_id uuid,
  p_use_service_role boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_phone text;
  v_payload jsonb;
BEGIN
  SELECT NULLIF(btrim(phone), '') INTO v_phone FROM public.vendors WHERE id = p_vendor_id;
  IF v_phone IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.user_notifications (
    user_phone, type, title, body, route, route_params, related_id, is_informational, is_read
  ) VALUES (
    v_phone, p_type, p_title, p_body, p_route, COALESCE(p_route_params, '{}'::jsonb),
    p_related_id, false, false
  );

  v_payload := jsonb_build_object(
    'vendor_id', p_vendor_id,
    'notification_title', p_title,
    'message', p_body,
    'type', p_type,
    'route', p_route,
    'route_params', COALESCE(p_route_params, '{}'::jsonb),
    'skip_inbox', true
  );
  IF p_request_id IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('request_id', p_request_id);
  END IF;
  IF p_referral_id IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('referral_id', p_referral_id);
  END IF;

  PERFORM public._pg_net_notify_vendor(v_payload, p_use_service_role);
END;
$$;

CREATE OR REPLACE FUNCTION public._user_inbox_and_fcm(
  p_user_phone text,
  p_title text,
  p_body text,
  p_type text,
  p_route text,
  p_route_params jsonb,
  p_order_id uuid,
  p_vendor_id uuid,
  p_use_service_role boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_phone text := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  v_payload jsonb;
BEGIN
  IF v_phone IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.user_notifications (
    user_phone, type, title, body, route, route_params, related_id, is_informational, is_read
  ) VALUES (
    v_phone, p_type, p_title, p_body, p_route, COALESCE(p_route_params, '{}'::jsonb),
    p_order_id, false, false
  );

  v_payload := jsonb_build_object(
    'user_phone', v_phone,
    'title', p_title,
    'body', p_body,
    'type', p_type,
    'route', p_route,
    'route_params', COALESCE(p_route_params, '{}'::jsonb),
    'skip_inbox', true
  );
  IF p_order_id IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('order_id', p_order_id);
  END IF;
  IF p_vendor_id IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('vendor_id', p_vendor_id);
  END IF;

  PERFORM public._pg_net_notify_user(v_payload, p_use_service_role);
END;
$$;

REVOKE ALL ON FUNCTION public._vendor_inbox_and_fcm(uuid, text, text, text, text, jsonb, uuid, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._user_inbox_and_fcm(text, text, text, text, text, jsonb, uuid, uuid, boolean) FROM PUBLIC;

-- ── Referral credit (vendor_credits INSERT) ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_vendor_on_referral_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_phone text;
  v_title text;
  v_body text;
BEGIN
  IF NEW.referral_id IS NULL OR NEW.vendor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone FROM public.vendors WHERE id = NEW.vendor_id;
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    'referral_credit',
    v_phone,
    jsonb_build_object('amount', COALESCE(NEW.amount, 2.5)::text)
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    NEW.vendor_id, v_title, v_body, 'referral_credit', 'vendor',
    jsonb_build_object('vendor_id', NEW.vendor_id),
    NEW.referral_id, NULL, NEW.referral_id, false
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_vendor_on_referral_credit ON public.vendor_credits;
CREATE TRIGGER trg_notify_vendor_on_referral_credit
  AFTER INSERT ON public.vendor_credits
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_vendor_on_referral_credit();

-- ── Users: warn / ban / restore ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_user_on_moderation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_phone text := NULLIF(btrim(COALESCE(NEW.phone, '')), '');
BEGIN
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.warn_count IS DISTINCT FROM OLD.warn_count
     AND COALESCE(NEW.warn_count, 0) > COALESCE(OLD.warn_count, 0) THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('account_warning', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'account_warning', 'settings', '{}'::jsonb,
      NULL, NULL, true
    );
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(NEW.is_banned, false) IS DISTINCT FROM COALESCE(OLD.is_banned, false) THEN
    IF NEW.is_banned IS TRUE THEN
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format('account_banned_user', v_phone, '{}'::jsonb) f;
      PERFORM public._user_inbox_and_fcm(
        v_phone, v_title, v_body, 'account_banned', 'settings', '{}'::jsonb,
        NULL, NULL, true
      );
    ELSIF COALESCE(OLD.is_banned, false) IS TRUE AND COALESCE(NEW.is_banned, false) IS FALSE THEN
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format('account_restored', v_phone, '{}'::jsonb) f;
      PERFORM public._user_inbox_and_fcm(
        v_phone, v_title, v_body, 'account_restored', 'settings', '{}'::jsonb,
        NULL, NULL, true
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_user_on_moderation ON public.users;
CREATE TRIGGER trg_notify_user_on_moderation
  AFTER UPDATE OF warn_count, is_banned ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_user_on_moderation();

-- ── Vendors: ban/restore, waiveoff, green_pending, insert, phone edit ─────────

CREATE OR REPLACE FUNCTION public.notify_on_vendor_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_phone text;
  v_shop text;
  v_cat text;
  v_mode text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_shop := COALESCE(NULLIF(btrim(NEW.shop_name), ''), 'Vendor');
    v_cat := COALESCE(NULLIF(btrim(NEW.category), ''), 'New');
    v_mode := COALESCE(NULLIF(btrim(NEW.service_mode), ''), 'delivery');
    SELECT f.title INTO v_title
    FROM public.notification_i18n_format('new_vendor', 'en', '{}'::jsonb) f;
    PERFORM public._pg_net_notify_admin(
      v_title,
      v_shop || ' — ' || v_cat || ' (' || v_mode || ')',
      'new_vendor',
      'settings',
      jsonb_build_object('vendor_id', NEW.id)
    );
    RETURN NEW;
  END IF;

  v_phone := NULLIF(btrim(COALESCE(NEW.phone, '')), '');
  v_shop := COALESCE(NULLIF(btrim(NEW.shop_name), ''), 'Vendor');

  IF COALESCE(NEW.is_banned, false) IS DISTINCT FROM COALESCE(OLD.is_banned, false) THEN
    IF NEW.is_banned IS TRUE THEN
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'account_banned_vendor', COALESCE(v_phone, 'en'), '{}'::jsonb
      ) f;
      PERFORM public._vendor_inbox_and_fcm(
        NEW.id, v_title, v_body, 'account_banned', 'vendor', '{}'::jsonb,
        NULL, NULL, NULL, true
      );
    ELSIF COALESCE(OLD.is_banned, false) IS TRUE AND COALESCE(NEW.is_banned, false) IS FALSE THEN
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'account_restored', COALESCE(v_phone, 'en'), '{}'::jsonb
      ) f;
      PERFORM public._vendor_inbox_and_fcm(
        NEW.id, v_title, v_body, 'account_restored', 'vendor', '{}'::jsonb,
        NULL, NULL, NULL, true
      );
    END IF;
  END IF;

  IF (NEW.waiveoff_percent IS DISTINCT FROM OLD.waiveoff_percent
      OR NEW.waiveoff_months_remaining IS DISTINCT FROM OLD.waiveoff_months_remaining)
     AND COALESCE(NEW.waiveoff_percent, 0) > 0
     AND COALESCE(NEW.waiveoff_months_remaining, 0) > 0 THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'subscription_update',
      COALESCE(v_phone, 'en'),
      jsonb_build_object(
        'percent', NEW.waiveoff_percent::text,
        'months', NEW.waiveoff_months_remaining::text
      )
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.id, v_title, v_body, 'subscription_update', 'vendor', '{}'::jsonb,
      NULL, NULL, NULL, true
    );
  END IF;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status
     AND NEW.verification_status = 'green_pending' THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'vendor_green_ready', 'en', jsonb_build_object('shop', v_shop)
    ) f;
    PERFORM public._pg_net_notify_admin(
      v_title, v_body, 'vendor_green_ready', 'settings',
      jsonb_build_object('vendor_id', NEW.id)
    );
  END IF;

  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    SELECT f.title INTO v_title
    FROM public.notification_i18n_format('vendor_edited', 'en', '{}'::jsonb) f;
    PERFORM public._pg_net_notify_admin(
      v_title,
      v_shop || ' — phone',
      'vendor_edited',
      'settings',
      jsonb_build_object('vendor_id', NEW.id)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_vendor_insert ON public.vendors;
CREATE TRIGGER trg_notify_on_vendor_insert
  AFTER INSERT ON public.vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_vendor_changes();

DROP TRIGGER IF EXISTS trg_notify_on_vendor_update ON public.vendors;
CREATE TRIGGER trg_notify_on_vendor_update
  AFTER UPDATE OF is_banned, waiveoff_percent, waiveoff_months_remaining, verification_status, phone
  ON public.vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_vendor_changes();

-- ── vendor_categories: green_pending + account_verified ──────────────────────

CREATE OR REPLACE FUNCTION public.notify_on_vendor_category_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_shop text;
  v_title text;
  v_body text;
  v_phone text;
BEGIN
  SELECT COALESCE(NULLIF(btrim(shop_name), ''), 'Vendor'), NULLIF(btrim(phone), '')
  INTO v_shop, v_phone
  FROM public.vendors WHERE id = NEW.vendor_id;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status
     AND NEW.verification_status = 'green_pending' THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'vendor_green_ready', 'en', jsonb_build_object('shop', COALESCE(v_shop, 'Vendor'))
    ) f;
    PERFORM public._pg_net_notify_admin(
      v_title, v_body, 'vendor_green_ready', 'settings',
      jsonb_build_object('vendor_id', NEW.vendor_id)
    );
  END IF;

  IF COALESCE(NEW.is_manual_verified, false) IS TRUE
     AND COALESCE(OLD.is_manual_verified, false) IS FALSE THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'account_verified', COALESCE(v_phone, 'en'), '{}'::jsonb
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'account_verified', 'vendor', '{}'::jsonb,
      NULL, NULL, NULL, true
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_vendor_category_changes ON public.vendor_categories;
CREATE TRIGGER trg_notify_on_vendor_category_changes
  AFTER UPDATE OF verification_status, is_manual_verified ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_vendor_category_changes();

-- ── Categories approve/reject ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_vendor_on_category_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_key text;
  v_type text;
  v_phone text;
BEGIN
  IF NEW.suggested_by_vendor_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'active' AND COALESCE(OLD.status, '') IS DISTINCT FROM 'active' THEN
    v_key := 'category_approved';
    v_type := 'category_approved';
  ELSIF NEW.status = 'rejected' AND COALESCE(OLD.status, '') IS DISTINCT FROM 'rejected' THEN
    v_key := 'category_rejected';
    v_type := 'category_rejected';
  ELSE
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone
  FROM public.vendors WHERE id = NEW.suggested_by_vendor_id;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    v_key, COALESCE(v_phone, 'en'), jsonb_build_object('label', COALESCE(NEW.label, ''))
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    NEW.suggested_by_vendor_id, v_title, v_body, v_type, 'settings',
    jsonb_build_object('vendor_id', NEW.suggested_by_vendor_id, 'category_id', NEW.id),
    NEW.id, NULL, NULL, true
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_vendor_on_category_review ON public.categories;
CREATE TRIGGER trg_notify_vendor_on_category_review
  AFTER UPDATE OF status, pending_review, is_active ON public.categories
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_vendor_on_category_review();

-- ── Support contact → admin ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_admin_on_support_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_who text;
  v_title text;
  v_body text;
  v_params jsonb := '{}'::jsonb;
BEGIN
  IF NEW.kind IS DISTINCT FROM 'contact' THEN
    RETURN NEW;
  END IF;

  v_who := COALESCE(NULLIF(btrim(NEW.user_phone), ''), NEW.vendor_id::text, 'unknown');
  v_title := left('Support: ' || COALESCE(NULLIF(btrim(NEW.category), ''), 'other'), 100);
  v_body := left(v_who || ': ' || COALESCE(NEW.message, ''), 100);

  IF NULLIF(btrim(NEW.user_phone), '') IS NOT NULL THEN
    v_params := v_params || jsonb_build_object('phone', btrim(NEW.user_phone));
  END IF;
  IF NEW.vendor_id IS NOT NULL THEN
    v_params := v_params || jsonb_build_object('vendor_id', NEW.vendor_id);
  END IF;
  IF NULLIF(btrim(NEW.category), '') IS NOT NULL THEN
    v_params := v_params || jsonb_build_object('category', btrim(NEW.category));
  END IF;

  PERFORM public._pg_net_notify_admin(v_title, v_body, 'support_contact', 'settings', v_params);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admin_on_support_contact ON public.support_messages;
CREATE TRIGGER trg_notify_admin_on_support_contact
  AFTER INSERT ON public.support_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_admin_on_support_contact();

-- ── Order lifecycle (requests UPDATE) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_on_request_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_phone text := NULLIF(btrim(COALESCE(NEW.user_phone, '')), '');
  v_vendor_phone text;
  v_amount text;
  v_utr text;
  v_copy text;
  v_engaged_old boolean;
  v_has_appt boolean;
  v_same_day boolean;
  v_customer text;
  v_ref_date date;
BEGIN
  v_engaged_old := (
    OLD.status IN ('accepted', 'fulfilled')
    OR COALESCE(OLD.appointment_status, '') = 'confirmed'
  );

  -- Appointment confirmed (takes priority over status→accepted in same UPDATE)
  IF NEW.appointment_status IS DISTINCT FROM OLD.appointment_status
     AND NEW.appointment_status = 'confirmed'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('appt_confirmed', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );

  -- Help accept: sent → accepted
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'accepted'
     AND OLD.status = 'sent'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('order_accepted_help', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_accepted', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );

  -- Delivery accept: seen → accepted
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'accepted'
     AND OLD.status = 'seen'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('order_accepted_delivery', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- Fulfilled
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'fulfilled'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('order_fulfilled', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- Payment confirmed
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status = 'confirmed'
     AND v_phone IS NOT NULL THEN
    SELECT COALESCE(round(ob.total_amount::numeric, 2)::text, '')
    INTO v_amount
    FROM public.order_bills ob
    WHERE ob.request_id = NEW.id
    ORDER BY ob.created_at DESC NULLS LAST
    LIMIT 1;
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'payment_confirmed', v_phone, jsonb_build_object('amount', COALESCE(v_amount, ''))
    ) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'payment_confirmed', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- Payment disputed
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status = 'disputed'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('payment_disputed', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'payment_disputed', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- Payment claimed → vendor
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status = 'claimed' THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    SELECT COALESCE(to_char(round(ob.total_amount::numeric, 2), 'FM999999990.00'), '')
    INTO v_amount
    FROM public.order_bills ob
    WHERE ob.request_id = NEW.id
    ORDER BY ob.created_at DESC NULLS LAST
    LIMIT 1;
    v_utr := COALESCE(NULLIF(btrim(NEW.payment_utr), ''), '');
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'payment_claimed',
      COALESCE(v_vendor_phone, 'en'),
      jsonb_build_object('amount', COALESCE(v_amount, ''), 'utr', v_utr)
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'payment_claimed', 'vendor',
      jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
    );
  END IF;

  -- Appointment declined by vendor
  IF NEW.appointment_status IS DISTINCT FROM OLD.appointment_status
     AND NEW.appointment_status = 'declined'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'appt_declined', v_phone,
      jsonb_build_object('reason', COALESCE(NULLIF(btrim(NEW.cancel_reason), ''), ''))
    ) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- Vendor cancel → user (cancel_reason set by vendor_cancel_order)
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'cancelled'
     AND NULLIF(btrim(NEW.cancel_reason), '') IS NOT NULL
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'order_cancelled_vendor', v_phone,
      jsonb_build_object('reason', btrim(NEW.cancel_reason))
    ) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- I've started
  IF OLD.vendor_started_at IS NULL AND NEW.vendor_started_at IS NOT NULL AND v_phone IS NOT NULL THEN
    IF NULLIF(btrim(NEW.delivery_slot), '') IS NOT NULL
       AND (NEW.appointment_time IS NULL OR btrim(COALESCE(NEW.appointment_time::text, '')) = '') THEN
      v_copy := 'ive_started_delivery';
    ELSIF NEW.delivery_slot IS NULL
       AND (NEW.appointment_time IS NULL OR btrim(COALESCE(NEW.appointment_time::text, '')) = '') THEN
      v_copy := 'ive_started_help';
    ELSE
      v_copy := 'ive_started_appointment';
    END IF;
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(v_copy, v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  -- Customer cancel when previously engaged → vendor
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'cancelled'
     AND NULLIF(btrim(COALESCE(NEW.cancel_reason, '')), '') IS NULL
     AND v_engaged_old THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'customer_cancelled', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'order_update', 'vendor',
      jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
    );
  END IF;

  -- Customer dismiss / appointment cancel via dismiss_order (status→done)
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'done'
     AND v_engaged_old THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    IF NEW.appointment_status IS DISTINCT FROM OLD.appointment_status
       AND NEW.appointment_status = 'cancelled' THEN
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'customer_cancelled', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
      ) f;
    ELSE
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'customer_dismissed', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
      ) f;
    END IF;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'order_update', 'vendor',
      jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
    );
  END IF;

  -- Order edit notify (message change) with 2-min vendor dedup
  IF NEW.message IS DISTINCT FROM OLD.message
     AND COALESCE(NEW.is_edited, false) IS TRUE THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    IF v_vendor_phone IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_notifications n
      WHERE n.user_phone = v_vendor_phone
        AND n.type = 'order_update'
        AND n.created_at > now() - interval '2 minutes'
    ) THEN
      v_has_appt := NEW.appointment_time IS NOT NULL
        AND btrim(COALESCE(NEW.appointment_time::text, '')) <> '';
      v_ref_date := CASE
        WHEN v_has_appt THEN (NEW.appointment_time AT TIME ZONE 'UTC')::date
        ELSE (NEW.created_at AT TIME ZONE 'UTC')::date
      END;
      v_same_day := (v_ref_date = (now() AT TIME ZONE 'UTC')::date);
      v_customer := COALESCE(NULLIF(btrim(NEW.user_phone), ''), 'Customer');
      IF v_has_appt AND v_same_day THEN
        v_copy := 'order_edited_same_day_appt';
      ELSIF v_has_appt THEN
        v_copy := 'order_edited_appt';
      ELSIF v_same_day THEN
        v_copy := 'order_edited_same_day';
      ELSE
        v_copy := 'order_edited';
      END IF;
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        v_copy, COALESCE(v_vendor_phone, 'en'),
        jsonb_build_object('customer', v_customer)
      ) f;
      PERFORM public._vendor_inbox_and_fcm(
        NEW.vendor_id, v_title, v_body, 'order_update', 'vendor',
        jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_request_lifecycle ON public.requests;
CREATE TRIGGER trg_notify_on_request_lifecycle
  AFTER UPDATE ON public.requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_request_lifecycle();

-- ── Low rating review → vendor ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_vendor_on_low_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_phone text;
BEGIN
  IF NEW.rating IS NULL OR NEW.rating > 2 OR NEW.vendor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone FROM public.vendors WHERE id = NEW.vendor_id;
  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    'review_low_rating', COALESCE(v_phone, 'en'), '{}'::jsonb
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    NEW.vendor_id, v_title, v_body, 'review_received', 'settings',
    jsonb_build_object('vendor_id', NEW.vendor_id, 'open_reviews', '1'),
    NEW.request_id, NEW.request_id, NULL, false
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_vendor_on_low_rating ON public.vendor_reviews;
CREATE TRIGGER trg_notify_vendor_on_low_rating
  AFTER INSERT ON public.vendor_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_vendor_on_low_rating();

-- ── Khata settle outstanding→0 → user ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_user_on_khata_cleared()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_phone text := NULLIF(btrim(COALESCE(NEW.user_phone, '')), '');
  v_linked uuid;
  v_params jsonb;
BEGIN
  IF NOT (
    COALESCE(OLD.total_outstanding, 0) > 0
    AND COALESCE(NEW.total_outstanding, 0) = 0
  ) THEN
    RETURN NEW;
  END IF;
  IF v_phone IS NULL OR NEW.vendor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.request_id INTO v_linked
  FROM public.khata_transactions t
  WHERE t.vendor_id = NEW.vendor_id
    AND t.user_phone = v_phone
    AND t.request_id IS NOT NULL
  ORDER BY t.created_at DESC
  LIMIT 1;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format('khata_paid', v_phone, '{}'::jsonb) f;

  v_params := CASE
    WHEN v_linked IS NOT NULL THEN jsonb_build_object('order_id', v_linked)
    ELSE '{}'::jsonb
  END;

  PERFORM public._user_inbox_and_fcm(
    v_phone, v_title, v_body, 'bill', 'my-orders', v_params,
    v_linked, NEW.vendor_id, false
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_user_on_khata_cleared ON public.khata_ledger;
CREATE TRIGGER trg_notify_user_on_khata_cleared
  AFTER UPDATE OF total_outstanding ON public.khata_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_user_on_khata_cleared();

COMMENT ON FUNCTION public.notify_vendor_on_referral_credit() IS
  'AFTER INSERT vendor_credits: referral_credit vendor inbox + FCM (anon_key + referral_id).';
COMMENT ON FUNCTION public.notify_on_request_lifecycle() IS
  'AFTER UPDATE requests: order/payment/appt/start/edit/cancel customer↔vendor notifies.';
COMMENT ON FUNCTION public.notify_user_on_khata_cleared() IS
  'AFTER UPDATE khata_ledger when outstanding hits 0: bill-type user notify.';


