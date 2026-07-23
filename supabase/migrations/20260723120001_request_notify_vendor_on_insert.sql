-- Server-triggered notify-vendor on new requests (Help/Delivery/Appointment).
-- Replaces client-side void invokeNotifyVendor from ParchiSheet after create_customer_request.
-- Pattern matches feed_post_after_insert / order_bill_after_insert (pg_net + app_config).
-- requests already has trg_set_fulfilled_at (BEFORE UPDATE only) — this is a separate AFTER INSERT.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.notify_vendor_on_request_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  notify_url text;
  notify_key text;
  v_message text;
BEGIN
  SELECT value INTO notify_url FROM public.app_config WHERE key = 'edge_function_url';
  SELECT value INTO notify_key FROM public.app_config WHERE key = 'anon_key';

  IF notify_url IS NULL OR notify_key IS NULL THEN
    RETURN NEW;
  END IF;

  v_message := left(COALESCE(NEW.message, ''), 100);

  PERFORM net.http_post(
    url := notify_url || '/notify-vendor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || notify_key
    ),
    body := jsonb_build_object(
      'vendor_id', NEW.vendor_id,
      'message', v_message,
      'type', 'new_order',
      'request_id', NEW.id,
      'route', 'vendor',
      'route_params', jsonb_build_object('order_id', NEW.id)
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_vendor_on_order ON public.requests;
DROP TRIGGER IF EXISTS request_after_insert_notify_vendor ON public.requests;

CREATE TRIGGER request_after_insert_notify_vendor
AFTER INSERT ON public.requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_vendor_on_request_insert();

COMMENT ON FUNCTION public.notify_vendor_on_request_insert() IS
  'AFTER INSERT on requests: pg_net POST to notify-vendor (type=new_order). Source of truth for vendor new-order push/inbox.';
