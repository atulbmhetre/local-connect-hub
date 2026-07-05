-- Track notify-vendors-tomorrow-orders cron in git (was dashboard-created, hardcoded PROD URL + anon JWT).
-- Same reconciliation pattern as ping-active-vendors-location.
-- Function endpoint is singular "notify-vendor-tomorrow" (cron job name says "vendors", function path says "vendor" — intentional, matches existing deployed function).
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'notify-vendors-tomorrow-orders';

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
