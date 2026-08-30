-- Bind vendor-docs license-docs/* to the calling vendor's identity, and
-- guard categories.license_review_status against direct (non-RPC) writes.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

-- ── storage: license-docs/{vendor_id}/… only for that vendor's session ────────

CREATE OR REPLACE FUNCTION public.storage_license_docs_owned(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.phone = public.auth_user_phone()
      AND p_name LIKE 'license-docs/' || v.id::text || '/%'
  );
$$;

COMMENT ON FUNCTION public.storage_license_docs_owned(text) IS
  'True when storage object path is license-docs/{this session vendor id}/…';

REVOKE ALL ON FUNCTION public.storage_license_docs_owned(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_license_docs_owned(text)
  TO anon, authenticated;

DROP POLICY IF EXISTS "Anon upload vendor docs license" ON storage.objects;
DROP POLICY IF EXISTS "Anon update vendor docs license" ON storage.objects;
DROP POLICY IF EXISTS "Vendor read own license docs" ON storage.objects;
DROP POLICY IF EXISTS "Public read vendor docs" ON storage.objects;

-- Public bucket listing must not enumerate license-docs (other prefixes stay public).
CREATE POLICY "Public read vendor docs"
ON storage.objects FOR SELECT
TO public
USING (
  bucket_id = 'vendor-docs'
  AND name NOT LIKE 'license-docs/%'
);

CREATE POLICY "Vendor read own license docs"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (
  bucket_id = 'vendor-docs'
  AND public.storage_license_docs_owned(name)
);

CREATE POLICY "Anon upload vendor docs license"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND public.storage_license_docs_owned(name)
);

CREATE POLICY "Anon update vendor docs license"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (
  bucket_id = 'vendor-docs'
  AND public.storage_license_docs_owned(name)
)
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND public.storage_license_docs_owned(name)
);

-- ── categories: license_review_status is admin-RPC-only ───────────────────────
-- Recreate the latest body (20260719120001) plus the new categories column.

CREATE OR REPLACE FUNCTION public.prevent_direct_admin_column_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public._admin_guard_bypassed() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'vendors' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_banned IS DISTINCT FROM OLD.is_banned
       OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason
       OR NEW.is_manual_verified IS DISTINCT FROM OLD.is_manual_verified
       OR NEW.waiveoff_percent IS DISTINCT FROM OLD.waiveoff_percent
       OR NEW.waiveoff_months_remaining IS DISTINCT FROM OLD.waiveoff_months_remaining THEN
      RAISE EXCEPTION 'direct admin column write blocked on vendors';
    END IF;

  ELSIF TG_TABLE_NAME = 'users' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_banned IS DISTINCT FROM OLD.is_banned
       OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason
       OR NEW.warn_count IS DISTINCT FROM OLD.warn_count
       OR NEW.trust_score IS DISTINCT FROM OLD.trust_score THEN
      RAISE EXCEPTION 'direct admin column write blocked on users';
    END IF;

  ELSIF TG_TABLE_NAME = 'categories' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.pending_review IS DISTINCT FROM OLD.pending_review
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.license_review_status IS DISTINCT FROM OLD.license_review_status THEN
      RAISE EXCEPTION 'direct admin column write blocked on categories';
    END IF;

  ELSIF TG_TABLE_NAME = 'app_config' AND TG_OP = 'UPDATE' THEN
    IF NEW.value IS DISTINCT FROM OLD.value THEN
      RAISE EXCEPTION 'direct app_config value write blocked';
    END IF;

  ELSIF TG_TABLE_NAME = 'app_config' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'direct app_config insert blocked';

  ELSIF TG_TABLE_NAME = 'vendor_verification' AND TG_OP = 'INSERT' THEN
    IF NEW.check_type = 'admin_check' AND NEW.checked_by = 'admin' THEN
      RAISE EXCEPTION 'direct admin_check insert blocked on vendor_verification';
    END IF;

  ELSIF TG_TABLE_NAME = 'vendor_verification' AND TG_OP = 'UPDATE' THEN
    IF OLD.check_type = 'admin_check' OR NEW.check_type = 'admin_check' THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR NEW.is_latest IS DISTINCT FROM OLD.is_latest
         OR NEW.checked_by IS DISTINCT FROM OLD.checked_by THEN
        RAISE EXCEPTION 'direct admin_check update blocked on vendor_verification';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'vendor_reviews' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct vendor_reviews delete blocked';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
