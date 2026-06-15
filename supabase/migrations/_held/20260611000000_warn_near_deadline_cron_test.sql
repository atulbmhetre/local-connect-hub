-- Schedule warn-near-deadline edge function via pg_cron (TEST: hhdylnhqdzfabsolwxdz).
-- Push this migration only to the TEST Supabase project.

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
    url := 'https://hhdylnhqdzfabsolwxdz.supabase.co/functions/v1/warn-near-deadline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoZHlsbmhxZHpmYWJzb2x3eGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDQ0ODEsImV4cCI6MjA5NjAyMDQ4MX0.CWGB3IcOmFK7NsHIy6bgPulRfVGRuDxXDzdEZ7V777s'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
