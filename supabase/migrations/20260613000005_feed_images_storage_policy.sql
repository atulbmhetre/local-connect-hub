-- Drop existing
DROP POLICY IF EXISTS "Authenticated upload only" ON storage.objects;
DROP POLICY IF EXISTS "Public read" ON storage.objects;

-- Allow anon upload only to announcements/ and offers/ folders
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

-- Public read
CREATE POLICY "Public read feed images"
ON storage.objects FOR SELECT
TO anon
USING (bucket_id = 'feed-images');
