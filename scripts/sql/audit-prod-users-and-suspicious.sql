-- All policies on users + any policy with 'Anyone' or '_all' in name on PROD
SELECT jsonb_build_object(
  'users_policies', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'policy_name', p.polname,
      'command', CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END,
      'roles', COALESCE((SELECT jsonb_agg(rolname ORDER BY rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)), '[]'::jsonb),
      'is_public', (p.polroles = '{}'::oid[]),
      'using_expr', pg_get_expr(p.polqual, p.polrelid),
      'with_check_expr', pg_get_expr(p.polwithcheck, p.polrelid)
    ) ORDER BY p.polname), '[]'::jsonb)
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'users'
  ),
  'suspicious_name_policies', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'table', c.relname,
      'policy_name', p.polname,
      'command', CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END,
      'roles', COALESCE((SELECT jsonb_agg(rolname ORDER BY rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)), '[]'::jsonb),
      'is_public', (p.polroles = '{}'::oid[]),
      'using_expr', pg_get_expr(p.polqual, p.polrelid),
      'with_check_expr', pg_get_expr(p.polwithcheck, p.polrelid)
    ) ORDER BY c.relname, p.polname), '[]'::jsonb)
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND (
        p.polname ILIKE '%all%'
        OR p.polname ILIKE 'Anyone%'
        OR p.polname ILIKE 'Allow %'
      )
  )
) AS prod_extra_audit;
