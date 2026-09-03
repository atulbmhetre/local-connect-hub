-- is_admin_phone is an oracle for app_config.admin_phone. RLS that still
-- referenced it is switched to is_admin_session(); anon must not EXECUTE it.

DROP POLICY IF EXISTS admin_alerts_admin ON public.admin_alerts;
DROP POLICY IF EXISTS "admin_alerts_admin" ON public.admin_alerts;

-- Recreate from 20260626000007 with session gate.
DROP POLICY IF EXISTS admin_alerts_select ON public.admin_alerts;
DROP POLICY IF EXISTS admin_alerts_all ON public.admin_alerts;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pol.polname
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'admin_alerts'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.admin_alerts', r.polname);
  END LOOP;
END $$;

CREATE POLICY admin_alerts_admin ON public.admin_alerts
  FOR ALL
  TO authenticated
  USING (public.is_admin_session())
  WITH CHECK (public.is_admin_session());

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pol.polname
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'fcm_delivery_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.fcm_delivery_log', r.polname);
  END LOOP;
END $$;

CREATE POLICY fcm_delivery_log_admin ON public.fcm_delivery_log
  FOR ALL
  TO authenticated
  USING (public.is_admin_session())
  WITH CHECK (public.is_admin_session());

REVOKE EXECUTE ON FUNCTION public.is_admin_phone(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin_phone(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin_phone(text) TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_admin_session() TO authenticated;
