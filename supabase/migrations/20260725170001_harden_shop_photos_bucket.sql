-- Harden shop-photos on PROD:
-- 1) Drop legacy unscoped policies (TO public / all roles) that duplicate the
--    intentional Anon upload / Public read policies the app already uses.
-- 2) Align bucket mime + size limits with menu-photos / vendor-selfies (5MB).

DROP POLICY IF EXISTS "Allow public upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow public view" ON storage.objects;

UPDATE storage.buckets
SET
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
WHERE id = 'shop-photos';
