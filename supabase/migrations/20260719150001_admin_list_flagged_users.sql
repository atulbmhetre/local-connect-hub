-- Flagged Users RLS fix: the admin panel read Flagged Users via a direct
-- .from("users") select, but users_owner RLS (phone = auth_user_phone())
-- only exposes the caller's own row — an admin session saw an empty list.
-- admin_list_flagged_users returns the same flagged set (noshow/fake/banned)
-- through a SECURITY DEFINER RPC gated by is_admin_session(), matching the
-- admin_ban_vendor gate/error pattern (20260708000002).

CREATE OR REPLACE FUNCTION public.admin_list_flagged_users(
  p_admin_phone text
)
RETURNS TABLE (
  phone text,
  trust_score double precision,
  noshow_count integer,
  fake_count integer,
  is_banned boolean,
  ban_reason text,
  warn_count integer,
  last_warned_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  RETURN QUERY
  SELECT
    u.phone,
    u.trust_score,
    u.noshow_count,
    u.fake_count,
    u.is_banned,
    u.ban_reason,
    u.warn_count,
    u.last_warned_at
  FROM public.users u
  WHERE u.noshow_count > 0
     OR u.fake_count > 0
     OR u.is_banned = true
  ORDER BY u.trust_score ASC
  LIMIT 5000;
END;
$$;

COMMENT ON FUNCTION public.admin_list_flagged_users(text) IS
  'Admin: flagged users (noshow/fake/banned) for the moderation panel; bypasses users_owner RLS via is_admin_session() gate.';

REVOKE ALL ON FUNCTION public.admin_list_flagged_users(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_flagged_users(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_flagged_users(text) TO authenticated;
