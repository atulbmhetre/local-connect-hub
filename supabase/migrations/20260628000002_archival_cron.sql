-- Monthly archival: delete old terminal orders, read notifications, FCM logs, and test OTP rows.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'archive-old-data';

SELECT cron.schedule(
  'archive-old-data',
  '0 2 1 * *',
  $$
    DELETE FROM public.requests
    WHERE created_at < now() - interval '180 days'
      AND status IN ('cancelled', 'expired', 'fulfilled');

    DELETE FROM public.user_notifications
    WHERE created_at < now() - interval '90 days'
      AND is_read = true;

    DELETE FROM public.fcm_delivery_log
    WHERE created_at < now() - interval '90 days';

    DELETE FROM public._test_otp_capture
    WHERE created_at < now() - interval '7 days';
  $$
);
