-- Single-result JSON dump of SELECT RLS state for users, order_bills, khata_ledger
SELECT jsonb_build_object(
  'project_query_run_at', now(),
  'tables', (
    SELECT jsonb_agg(
      jsonb_build_object(
        'table_name', c.relname,
        'rls_enabled', c.relrowsecurity,
        'rls_forced', c.relforcerowsecurity,
        'select_policies', (
          SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
              'policy_name', p.polname,
              'command', CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN '*' THEN 'ALL' END,
              'permissive', p.polpermissive,
              'roles', (
                SELECT COALESCE(jsonb_agg(rolname ORDER BY rolname), '[]'::jsonb)
                FROM pg_roles r WHERE r.oid = ANY (p.polroles)
              ),
              'using_expr', pg_get_expr(p.polqual, p.polrelid),
              'with_check_expr', pg_get_expr(p.polwithcheck, p.polrelid)
            )
            ORDER BY p.polname
          ), '[]'::jsonb)
          FROM pg_policy p
          WHERE p.polrelid = c.oid AND p.polcmd IN ('r', '*')
        ),
        'all_policies', (
          SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
              'policy_name', p2.polname,
              'command', CASE p2.polcmd
                WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL'
              END,
              'using_expr', pg_get_expr(p2.polqual, p2.polrelid)
            )
            ORDER BY p2.polname
          ), '[]'::jsonb)
          FROM pg_policy p2
          WHERE p2.polrelid = c.oid
        )
      )
      ORDER BY c.relname
    )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('users', 'order_bills', 'khata_ledger')
  ),
  'auth_user_phone_def', (
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'auth_user_phone'
    LIMIT 1
  ),
  'anon_auth_user_phone', public.auth_user_phone(),
  'anon_uid', auth.uid()
) AS rls_audit;
