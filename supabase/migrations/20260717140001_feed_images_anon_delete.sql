-- Allow anon to delete feed-images under announcements/ and offers/ so the
-- client can best-effort remove an object if post-create RPC fails after upload.

DROP POLICY IF EXISTS "Anon delete feed images" ON storage.objects;

CREATE POLICY "Anon delete feed images"
ON storage.objects FOR DELETE
TO anon
USING (
  bucket_id = 'feed-images'
  AND (
    name LIKE 'announcements/%'
    OR name LIKE 'offers/%'
  )
);

-- Authenticated clients use the same paths (JWT role may be authenticated).
DROP POLICY IF EXISTS "Authenticated delete feed images" ON storage.objects;

CREATE POLICY "Authenticated delete feed images"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'feed-images'
  AND (
    name LIKE 'announcements/%'
    OR name LIKE 'offers/%'
  )
);
