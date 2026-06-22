-- DB-03: app_users.lang for localization preference
-- DB-04: feed_posts.type enum-like CHECK

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS lang text CHECK (lang IN ('en', 'hi', 'mr'));

-- Backfill legacy/invalid rows so the CHECK can be applied.
UPDATE public.feed_posts
SET type = 'announcement'
WHERE type IS NULL
   OR type NOT IN ('announcement', 'recommendation', 'offer');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'feed_posts_type_check'
      AND conrelid = 'public.feed_posts'::regclass
  ) THEN
    ALTER TABLE public.feed_posts
      ADD CONSTRAINT feed_posts_type_check
      CHECK (type IN ('announcement', 'recommendation', 'offer'));
  END IF;
END $$;
