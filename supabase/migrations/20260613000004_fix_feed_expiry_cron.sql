-- Fix announcement cleanup: delete by expires_at instead of created_at + 7 days
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'cleanup-feed-posts';

SELECT cron.schedule(
  'cleanup-feed-posts',
  '0 2 * * *',
  $$
    DELETE FROM public.feed_posts
    WHERE
      (type = 'announcement' AND expires_at IS NOT NULL AND expires_at < now())
      OR
      (type = 'offer' AND expires_at IS NOT NULL AND expires_at < now() - interval '7 days')
      OR
      (
        type = 'recommendation'
        AND created_at < now() - interval '1 year'
        AND id NOT IN (
          SELECT DISTINCT post_id
          FROM public.feed_replies
          WHERE created_at > now() - interval '1 year'
            AND post_id IS NOT NULL
        )
      );
  $$
);
