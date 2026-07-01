-- vendor-docs: UPI QR images at registration (VendorMode handleUpiQrFile → upi-qr/*).
-- Public bucket; anon may INSERT/UPDATE under upi-qr/ only (upsert: true in client).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vendor-docs',
  'vendor-docs',
  true,
  3145728,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Anon upload vendor docs upi qr" ON storage.objects;
DROP POLICY IF EXISTS "Anon update vendor docs upi qr" ON storage.objects;
DROP POLICY IF EXISTS "Public read vendor docs" ON storage.objects;

CREATE POLICY "Anon upload vendor docs upi qr"
ON storage.objects FOR INSERT
TO anon
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND name LIKE 'upi-qr/%'
);

CREATE POLICY "Anon update vendor docs upi qr"
ON storage.objects FOR UPDATE
TO anon
USING (
  bucket_id = 'vendor-docs'
  AND name LIKE 'upi-qr/%'
)
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND name LIKE 'upi-qr/%'
);

CREATE POLICY "Public read vendor docs"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'vendor-docs');
