-- TEST only: retire FCM location-ping cron (superseded by Capgo background-geolocation).
-- Do not apply the PROD sibling until Capgo real-device tracking is confirmed.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'ping-active-vendors-location';

DELETE FROM public.app_config
WHERE key = 'location_ping_seconds';
