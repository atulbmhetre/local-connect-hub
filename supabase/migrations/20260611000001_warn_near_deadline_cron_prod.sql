-- Schedule warn-near-deadline edge function via pg_cron (PROD: rpxsyeqskvhjmbkxnpmd).
-- Push this migration only to the PROD Supabase project.
-- Anon key from src/lib/supabase.ts (PROD fallback for rpxsyeqskvhjmbkxnpmd).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'warn-near-deadline';

SELECT cron.schedule(
  'warn-near-deadline',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rpxsyeqskvhjmbkxnpmd.supabase.co/functions/v1/warn-near-deadline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
