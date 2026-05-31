-- Nightly cleanup for expired/old feed_posts (02:00 UTC daily)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.schedule(
  'cleanup-feed-posts',
  '0 2 * * *',
  $$
    DELETE FROM public.feed_posts
    WHERE
      (type = 'announcement' AND created_at < now() - interval '7 days')
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
