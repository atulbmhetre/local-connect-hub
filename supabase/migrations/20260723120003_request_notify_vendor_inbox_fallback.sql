-- anon_key was removed from app_config during key rotation, so pg_net-only
-- notify (feed/bill pattern) cannot authenticate edge calls until ops restore a
-- publishable anon_key row. Make request notify work without that dependency:
-- 1) always insert vendor inbox row server-side
-- 2) best-effort FCM via notify-vendor with skip_inbox when edge_function_url + anon_key exist

CREATE OR REPLACE FUNCTION public.notify_vendor_on_request_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  notify_url text;
  notify_key text;
  v_phone text;
  v_category text;
  v_title text;
  v_body text;
  v_emoji text;
  v_label text;
BEGIN
  SELECT v.phone, v.category
  INTO v_phone, v_category
  FROM public.vendors v
  WHERE v.id = NEW.vendor_id;

  IF v_phone IS NULL OR btrim(v_phone) = '' THEN
    RETURN NEW;
  END IF;

  v_body := left(COALESCE(NEW.message, ''), 100);

  IF NEW.category_id IS NOT NULL THEN
    SELECT c.label, c.emoji
    INTO v_label, v_emoji
    FROM public.categories c
    WHERE c.id = NEW.category_id;
  END IF;

  IF v_label IS NULL THEN
    v_label := COALESCE(NULLIF(btrim(v_category), ''), 'New');
    SELECT c.emoji INTO v_emoji
    FROM public.categories c
    WHERE c.label = v_label
    LIMIT 1;
  END IF;

  v_title := CASE
    WHEN COALESCE(NULLIF(btrim(v_emoji), ''), '') <> '' THEN
      'New Order — ' || btrim(v_emoji) || ' ' || v_label
    ELSE
      'New Order — ' || v_label
  END;

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
    btrim(v_phone),
    'new_order',
    v_title,
    v_body,
    'vendor',
    jsonb_build_object('order_id', NEW.id),
    NEW.id,
    false,
    false
  );

  SELECT value INTO notify_url FROM public.app_config WHERE key = 'edge_function_url';
  SELECT value INTO notify_key FROM public.app_config WHERE key = 'anon_key';

  IF notify_url IS NOT NULL AND notify_key IS NOT NULL
     AND btrim(notify_url) <> '' AND btrim(notify_key) <> ''
  THEN
    PERFORM net.http_post(
      url := notify_url || '/notify-vendor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || notify_key
      ),
      body := jsonb_build_object(
        'vendor_id', NEW.vendor_id,
        'message', v_body,
        'type', 'new_order',
        'request_id', NEW.id,
        'route', 'vendor',
        'route_params', jsonb_build_object('order_id', NEW.id),
        'skip_inbox', true,
        'notification_title', v_title
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_vendor_on_request_insert() IS
  'AFTER INSERT on requests: vendor inbox new_order always; FCM via notify-vendor when app_config anon_key is set (skip_inbox).';
