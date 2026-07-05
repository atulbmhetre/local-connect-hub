-- Schedule check-vendor-subscriptions to run hourly on TEST
-- Pattern: same as other edge function crons in this project
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'check-vendor-subscriptions';

SELECT cron.schedule(
  'check-vendor-subscriptions',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.app_config WHERE key = 'edge_function_url') || '/check-vendor-subscriptions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'anon_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
