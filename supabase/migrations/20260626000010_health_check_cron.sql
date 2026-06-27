-- Schedule health-check-edge-functions edge function via pg_cron (same pattern as ping-active-vendors-location).
-- Runs every 15 minutes — pings AI edge functions and updates admin_alerts.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'health-check-edge-functions';

SELECT cron.schedule(
  'health-check-edge-functions',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.app_config WHERE key = 'edge_function_url') || '/health-check-edge-functions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
