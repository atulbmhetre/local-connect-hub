WITH open_policies AS (
  SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    p.polname AS policy_name,
    CASE p.polcmd
      WHEN 'r' THEN 'SELECT'
      WHEN 'a' THEN 'INSERT'
      WHEN 'w' THEN 'UPDATE'
      WHEN 'd' THEN 'DELETE'
      WHEN '*' THEN 'ALL'
    END AS command,
    p.polpermissive AS permissive,
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
        SELECT 1 FROM pg_roles r
        WHERE r.oid = ANY (p.polroles) AND r.rolname = 'anon'
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
  'policies', COALESCE((SELECT jsonb_agg(to_jsonb(open_policies) ORDER BY table_name, policy_name) FROM open_policies), '[]'::jsonb)
) AS prod_open_policy_audit;
