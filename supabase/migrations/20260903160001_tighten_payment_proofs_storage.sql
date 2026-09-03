-- Tighten payment-proofs: INSERT/UPDATE only when the object path is
-- {existing_request_id}/..., and drop world-readable listing.
-- Bucket stays public so existing getPublicUrl img tags still load by exact URL.

CREATE OR REPLACE FUNCTION public.storage_payment_proof_for_existing_request(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text;
  v_uuid uuid;
BEGIN
  v_id := split_part(coalesce(p_name, ''), '/', 1);
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  IF split_part(p_name, '/', 2) IS NULL OR btrim(split_part(p_name, '/', 2)) = '' THEN
    RETURN false;
  END IF;
  v_uuid := v_id::uuid;
  RETURN EXISTS (SELECT 1 FROM public.requests r WHERE r.id = v_uuid);
END;
$$;

COMMENT ON FUNCTION public.storage_payment_proof_for_existing_request(text) IS
  'True when storage path is {request_uuid}/{filename} and that request exists.';

REVOKE ALL ON FUNCTION public.storage_payment_proof_for_existing_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_payment_proof_for_existing_request(text)
  TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Customer upload payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Customer update payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Read payment proofs" ON storage.objects;

CREATE POLICY "Customer upload payment proofs"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'payment-proofs'
  AND public.storage_payment_proof_for_existing_request(name)
);

CREATE POLICY "Customer update payment proofs"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (
  bucket_id = 'payment-proofs'
  AND public.storage_payment_proof_for_existing_request(name)
)
WITH CHECK (
  bucket_id = 'payment-proofs'
  AND public.storage_payment_proof_for_existing_request(name)
);

CREATE POLICY "Admin read payment proofs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'payment-proofs'
  AND public.is_admin_session()
);
