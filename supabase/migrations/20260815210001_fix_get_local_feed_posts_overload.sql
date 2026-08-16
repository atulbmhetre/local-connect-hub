-- 20260815200001 added a 7-arg get_local_feed_posts without dropping the 5-arg overload,
-- which breaks PostgREST (PGRST203). Keep the paginated 7-arg version only.

DROP FUNCTION IF EXISTS public.get_local_feed_posts(
  double precision,
  double precision,
  integer,
  integer,
  uuid
);
