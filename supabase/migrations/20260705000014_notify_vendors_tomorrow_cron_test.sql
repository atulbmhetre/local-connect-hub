-- Add notify-vendors-tomorrow-orders to TEST for environment parity with PROD.
-- Harmless on TEST — synthetic vendors have no real phones checking for this push,
-- but keeping cron schedules identical across environments avoids future confusion.
SELECT cron.schedule(
  'notify-vendors-tomorrow-orders',
  '30 1 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.app_config WHERE key = 'edge_function_url') || '/notify-vendor-tomorrow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'anon_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
