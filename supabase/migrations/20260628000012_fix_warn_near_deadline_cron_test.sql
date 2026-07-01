-- Environment-agnostic cron fix: edge_function_url and service_role_key in app_config
-- already differ per project (TEST vs PROD). Safe to apply on both.

SET app.via_admin_rpc = 'true';

INSERT INTO public.app_config (key, value, description)
VALUES (
  'service_role_key',
  'REPLACE_ME_MANUALLY',
  'Service role key for cron Authorization headers — must be set manually via Supabase dashboard, never commit the real value'
)
ON CONFLICT (key) DO NOTHING;

RESET app.via_admin_rpc;

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
      'Authorization', 'Bearer ' || (SELECT value FROM public.app_config WHERE key = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
