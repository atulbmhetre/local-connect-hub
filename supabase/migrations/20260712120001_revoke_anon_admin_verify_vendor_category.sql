-- Align per-business verify RPCs with session-auth admin grants
-- (authenticated only; revoke anon) — same pattern as 20260708000002.

REVOKE ALL ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid)
  TO authenticated;
