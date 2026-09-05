-- Retire FCM location-ping cron everywhere (superseded by Capgo background-geolocation).
-- Idempotent: no-op when the job is already absent (TEST was unscheduled earlier).

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'ping-active-vendors-location';

DELETE FROM public.app_config
WHERE key = 'location_ping_seconds';
