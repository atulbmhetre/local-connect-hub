CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

INSERT INTO public.app_config (key, value)
VALUES ('feed_notification_radius_km', '5')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION notify_feed_post_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  notify_url text;
  notify_key text;
BEGIN
  IF NEW.lat IS NULL OR NEW.lng IS NULL OR NEW.user_phone IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT value INTO notify_url FROM app_config WHERE key = 'edge_function_url';
  SELECT value INTO notify_key FROM app_config WHERE key = 'anon_key';

  IF notify_url IS NULL OR notify_key IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := notify_url || '/notify-feed-post',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || notify_key
    ),
    body := jsonb_build_object(
      'post_id', NEW.id,
      'post_type', NEW.type,
      'lat', NEW.lat,
      'lng', NEW.lng,
      'author_phone', NEW.user_phone,
      'vendor_id', NEW.vendor_id
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feed_post_after_insert ON public.feed_posts;

CREATE TRIGGER feed_post_after_insert
AFTER INSERT ON public.feed_posts
FOR EACH ROW EXECUTE FUNCTION notify_feed_post_trigger();
