-- OTP-on registration signs the browser in before Step B. vendor-docs INSERT/UPDATE
-- was TO anon only, so handleUpiQrFile failed and skipped jsQR. Mirror shop-photos.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

DROP POLICY IF EXISTS "Anon upload vendor docs upi qr" ON storage.objects;
DROP POLICY IF EXISTS "Anon update vendor docs upi qr" ON storage.objects;

CREATE POLICY "Anon upload vendor docs upi qr"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND name LIKE 'upi-qr/%'
);

CREATE POLICY "Anon update vendor docs upi qr"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (
  bucket_id = 'vendor-docs'
  AND name LIKE 'upi-qr/%'
)
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND name LIKE 'upi-qr/%'
);
