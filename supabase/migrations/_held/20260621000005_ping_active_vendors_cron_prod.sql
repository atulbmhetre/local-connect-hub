-- Tracks the dashboard-only cron that existed on PROD since early sessions
-- Schedule: every minute — pings active vendors for GPS update
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'ping-active-vendors-location';

SELECT cron.schedule(
  'ping-active-vendors-location',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.app_config WHERE key = 'edge_function_url') || '/ping-active-vendors',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'anon_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
