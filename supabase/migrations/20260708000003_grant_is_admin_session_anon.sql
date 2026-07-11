-- Allow unauthenticated clients to call is_admin_session() (returns false when no JWT).
-- Authenticated admins already had EXECUTE from 20260708000002_admin_session_auth.sql.

GRANT EXECUTE ON FUNCTION public.is_admin_session() TO anon;
