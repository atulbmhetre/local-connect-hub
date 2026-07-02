-- Announcement/recommendation cleanup: honour expires_at (7-day client default) instead of created_at only.

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cleanup-feed-posts';

SELECT cron.schedule(
  'cleanup-feed-posts',
  '0 2 * * *',
  $$
  DELETE FROM public.feed_posts
  WHERE
    (type IN ('announcement', 'recommendation') AND expires_at IS NOT NULL AND expires_at < now())
    OR (type IN ('announcement', 'recommendation') AND expires_at IS NULL AND created_at < now() - interval '7 days')
    OR (type = 'offer' AND expires_at IS NOT NULL AND expires_at < now())
    OR (type = 'offer' AND expires_at IS NULL AND created_at < now() - interval '30 days');
  $$
);
