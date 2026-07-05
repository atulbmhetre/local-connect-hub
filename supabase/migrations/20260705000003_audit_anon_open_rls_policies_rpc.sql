-- Read-only RPC for tests/rls-policy-audit.spec.ts: list permissive public/anon RLS
-- policies on public tables whose USING or WITH CHECK is literally true.
CREATE OR REPLACE FUNCTION public.audit_anon_open_rls_policies()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH open_policies AS (
    SELECT
      c.relname AS table_name,
      p.polname AS policy_name,
      CASE p.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        WHEN '*' THEN 'ALL'
      END AS command,
      COALESCE(
        (
          SELECT jsonb_agg(rolname ORDER BY rolname)
          FROM pg_roles r
          WHERE r.oid = ANY (p.polroles)
        ),
        '[]'::jsonb
      ) AS roles,
      (p.polroles = '{}'::oid[]) AS is_public_role,
      pg_get_expr(p.polqual, p.polrelid) AS using_expr,
      pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.polpermissive = true
      AND (
        p.polroles = '{}'::oid[]
        OR EXISTS (
          SELECT 1
          FROM pg_roles r
          WHERE r.oid = ANY (p.polroles)
            AND r.rolname = 'anon'
        )
      )
      AND (
        (
          pg_get_expr(p.polqual, p.polrelid) IS NOT NULL
          AND btrim(pg_get_expr(p.polqual, p.polrelid)) IN ('true', '(true)')
        )
        OR (
          pg_get_expr(p.polwithcheck, p.polrelid) IS NOT NULL
          AND btrim(pg_get_expr(p.polwithcheck, p.polrelid)) IN ('true', '(true)')
        )
      )
  )
  SELECT jsonb_build_object(
    'queried_at', now(),
    'count', (SELECT count(*) FROM open_policies),
    'policies', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'table_name', table_name,
            'policy_name', policy_name,
            'command', command,
            'roles', roles,
            'is_public_role', is_public_role,
            'using_expr', using_expr,
            'with_check_expr', with_check_expr
          )
          ORDER BY table_name, policy_name
        )
        FROM open_policies
      ),
      '[]'::jsonb
    )
  );
$$;

REVOKE ALL ON FUNCTION public.audit_anon_open_rls_policies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_anon_open_rls_policies() TO service_role;

COMMENT ON FUNCTION public.audit_anon_open_rls_policies() IS
  'Returns anon/PUBLIC permissive RLS policies with USING or WITH CHECK = true. Used by tests/rls-policy-audit.spec.ts.';
