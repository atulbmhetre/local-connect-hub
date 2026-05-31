-- Public bucket for Local Feed announcement/offer images (see src/lib/imageUpload.ts)
INSERT INTO storage.buckets (id, name, public)
VALUES ('feed-images', 'feed-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "Allow public read feed-images" ON storage.objects;
CREATE POLICY "Allow public read feed-images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'feed-images');

DROP POLICY IF EXISTS "Allow public uploads to feed-images" ON storage.objects;
CREATE POLICY "Allow public uploads to feed-images"
ON storage.objects FOR INSERT
TO public
WITH CHECK (bucket_id = 'feed-images');

-- upload(..., { upsert: true }) in imageUpload.ts
DROP POLICY IF EXISTS "Allow public update feed-images" ON storage.objects;
CREATE POLICY "Allow public update feed-images"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'feed-images')
WITH CHECK (bucket_id = 'feed-images');
