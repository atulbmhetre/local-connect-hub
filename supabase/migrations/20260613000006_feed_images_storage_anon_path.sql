-- Revert A15 authenticated-only feed-images upload; restrict anon to announcements/ and offers/
DROP POLICY IF EXISTS "Authenticated upload only" ON storage.objects;
DROP POLICY IF EXISTS "Public read" ON storage.objects;
DROP POLICY IF EXISTS "Anon upload feed images" ON storage.objects;
DROP POLICY IF EXISTS "Public read feed images" ON storage.objects;

CREATE POLICY "Anon upload feed images"
ON storage.objects FOR INSERT
TO anon
WITH CHECK (
  bucket_id = 'feed-images'
  AND (
    name LIKE 'announcements/%'
    OR name LIKE 'offers/%'
  )
);

CREATE POLICY "Public read feed images"
ON storage.objects FOR SELECT
TO anon
USING (bucket_id = 'feed-images');
