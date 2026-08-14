-- Bill notify: trigger already inserts inbox; notify-user must skip its own inbox insert.
-- Matches notify_vendor_on_request_insert (20260723120003) skip_inbox convention.

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
  v_title text := 'Bill from your vendor';
  v_body text;
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

  v_body :=
    COALESCE(NULLIF(trim(v_shop_name), ''), 'Vendor')
    || ': ₹'
    || round(NEW.total_amount::numeric, 0)::text
    || ' — '
    || CASE NEW.payment_mode
      WHEN 'cash' THEN 'Cash'
      WHEN 'upi' THEN 'UPI'
      WHEN 'khata' THEN 'Khata'
      ELSE NEW.payment_mode
    END;

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
  'AFTER INSERT on order_bills: customer inbox bill row always; FCM via notify-user with skip_inbox.';
