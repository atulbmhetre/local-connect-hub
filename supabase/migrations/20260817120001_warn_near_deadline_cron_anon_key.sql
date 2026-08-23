-- warn-near-deadline cron was still authorizing with app_config.service_role_key.
-- That key was deleted on TEST and PROD during the July 2026 key-rotation incident
-- (docs/PRELAUNCH_AUDIT.md). pg_net then posts with a NULL Authorization header,
-- the gateway returns 401 UNAUTHORIZED_NO_AUTH_HEADER, and the edge never runs.
-- Inbox still appears because expire_pending_orders() calls
-- warn_pending_orders_near_deadline() in-process.
--
-- Align with every other working pg_net cron (ping-active-vendors, notify-vendors-tomorrow,
-- expire FCM, bill notify): Bearer app_config.anon_key. The edge uses SERVICE_ROLE from
-- its own secrets; the JWT is only for gateway verify_jwt.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'warn-near-deadline';

SELECT cron.schedule(
  'warn-near-deadline',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.app_config WHERE key = 'edge_function_url') || '/warn-near-deadline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'anon_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
