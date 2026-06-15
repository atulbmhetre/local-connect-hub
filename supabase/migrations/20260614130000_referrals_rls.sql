-- referrals / vendor_credits / app_users RLS codified for cross-env push (RF-REG-06).
-- Probed live on 2026-06-14:
--   TEST (hhdylnhqdzfabsolwxdz):
--     • referrals, vendor_credits, app_users — anon_all — ALL — anon
--   PROD (rpxsyeqskvhjmbkxnpmd):
--     • referrals — referrals_select (SELECT), referrals_insert (INSERT)
--     • vendor_credits — vendor_credits_select (SELECT) only
--     • app_users — app_users_select, app_users_insert, app_users_update
-- App runs as anon. Client ops audited:
--   referrals: SELECT (Settings verify), INSERT (recordUserReferral, edge fn via service role)
--   vendor_credits: SELECT (Settings credit totals), INSERT (recordUserReferral)
--   app_users: SELECT, INSERT, UPDATE (recordUserReferral); no client DELETE
-- vendor_credits_insert added — required for recordUserReferral() on TEST (was anon_all ALL).

------------------------------------------------------------------------------
-- referrals
------------------------------------------------------------------------------

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all" ON public.referrals;
DROP POLICY IF EXISTS "referrals_select" ON public.referrals;
DROP POLICY IF EXISTS "referrals_insert" ON public.referrals;

CREATE POLICY "referrals_select"
  ON public.referrals
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "referrals_insert"
  ON public.referrals
  FOR INSERT
  TO anon
  WITH CHECK (true);

------------------------------------------------------------------------------
-- vendor_credits
------------------------------------------------------------------------------

ALTER TABLE public.vendor_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all" ON public.vendor_credits;
DROP POLICY IF EXISTS "vendor_credits_select" ON public.vendor_credits;
DROP POLICY IF EXISTS "vendor_credits_insert" ON public.vendor_credits;

CREATE POLICY "vendor_credits_select"
  ON public.vendor_credits
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "vendor_credits_insert"
  ON public.vendor_credits
  FOR INSERT
  TO anon
  WITH CHECK (true);

------------------------------------------------------------------------------
-- app_users
------------------------------------------------------------------------------

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all" ON public.app_users;
DROP POLICY IF EXISTS "app_users_select" ON public.app_users;
DROP POLICY IF EXISTS "app_users_insert" ON public.app_users;
DROP POLICY IF EXISTS "app_users_update" ON public.app_users;

CREATE POLICY "app_users_select"
  ON public.app_users
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "app_users_insert"
  ON public.app_users
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "app_users_update"
  ON public.app_users
  FOR UPDATE
  TO anon
  USING (true);
