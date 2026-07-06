-- Complete scan: any policy with USING or WITH CHECK = true (all roles)
SELECT jsonb_build_object(
  'count', count(*),
  'policies', jsonb_agg(row_data ORDER BY table_name, policy_name)
)
FROM (
  SELECT jsonb_build_object(
    'table', c.relname,
    'policy_name', p.polname,
    'command', CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END,
    'roles', CASE
      WHEN p.polroles = '{}'::oid[] OR cardinality(p.polroles) = 0 THEN '"PUBLIC"'::jsonb
      ELSE COALESCE((SELECT jsonb_agg(rolname ORDER BY rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)), '[]'::jsonb)
    END,
    'using_expr', pg_get_expr(p.polqual, p.polrelid),
    'with_check_expr', pg_get_expr(p.polwithcheck, p.polrelid),
    'using_is_true', (btrim(coalesce(pg_get_expr(p.polqual, p.polrelid), '')) IN ('true', '(true)')),
    'with_check_is_true', (btrim(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) IN ('true', '(true)'))
  ) AS row_data,
  c.relname AS table_name,
  p.polname AS policy_name
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND p.polpermissive = true
    AND (
      btrim(coalesce(pg_get_expr(p.polqual, p.polrelid), '')) IN ('true', '(true)')
      OR btrim(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) IN ('true', '(true)')
    )
) sub;
