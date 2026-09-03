-- Close the authenticated-role oracle for app_config.admin_phone.
-- No client, test, or edge function calls is_admin_phone as an RPC.
-- Remaining uses are SECURITY DEFINER bodies (owner EXECUTE) and the two
-- RLS policies already replaced by is_admin_session() in 20260903170001.

REVOKE EXECUTE ON FUNCTION public.is_admin_phone(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin_phone(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin_phone(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_phone(text) TO service_role;
