SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'check-expiry-alerts';

SELECT cron.schedule(
  'check-expiry-alerts',
  '0 9 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.app_config WHERE key = 'edge_function_url') || '/check-expiry-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
