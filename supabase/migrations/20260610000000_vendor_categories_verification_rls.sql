-- Session 39 created vendor_categories / vendor_verification directly in the
-- dashboard with RLS enabled but NO policies for the anon role. The customer
-- app runs entirely as anon (src/lib/supabase.ts, no auth session), so:
--   * Radar category search returned 0 rows (SELECT silently filtered)
--   * vendor registration failed to write categories/verification (42501)
--   * shop-edit delete+reinsert and admin-check updates silently no-op'd
-- Probed live on 2026-06-10: anon SELECT returns 0 rows, anon INSERT raises
-- 42501 on both tables, anon UPDATE/DELETE affect 0 rows.
--
-- App operations that must work under anon (audited call sites):
--   vendor_categories:   SELECT (RadarSearch:304,354 / VendorMode:648 / Settings:854)
--                        INSERT (VendorMode:750,911)
--                        DELETE (VendorMode:738 shop-edit delete-then-reinsert)
--   vendor_verification: SELECT (RadarSearch:349 / Settings:859)
--                        INSERT (VendorMode:928,1293 / Settings:1402)
--                        UPDATE (Settings:1390 admin_check is_latest flip)

ALTER TABLE public.vendor_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_verification ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------------------
-- vendor_categories
------------------------------------------------------------------------------

-- All app reads filter status = 'approved'; pending/rejected rows stay hidden.
DROP POLICY IF EXISTS "Public can read approved vendor categories" ON public.vendor_categories;
CREATE POLICY "Public can read approved vendor categories"
  ON public.vendor_categories
  FOR SELECT
  TO anon, authenticated
  USING (status = 'approved');

DROP POLICY IF EXISTS "Public can insert vendor categories" ON public.vendor_categories;
CREATE POLICY "Public can insert vendor categories"
  ON public.vendor_categories
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Not used by the app today (shop edit does delete + reinsert), added for parity.
DROP POLICY IF EXISTS "Public can update vendor categories" ON public.vendor_categories;
CREATE POLICY "Public can update vendor categories"
  ON public.vendor_categories
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Public can delete vendor categories" ON public.vendor_categories;
CREATE POLICY "Public can delete vendor categories"
  ON public.vendor_categories
  FOR DELETE
  TO anon, authenticated
  USING (true);

------------------------------------------------------------------------------
-- vendor_verification
------------------------------------------------------------------------------

-- App reads filter is_latest = true client-side; trustLevel.ts also skips
-- is_latest = false rows defensively.
DROP POLICY IF EXISTS "Public can read vendor verification" ON public.vendor_verification;
CREATE POLICY "Public can read vendor verification"
  ON public.vendor_verification
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Public can insert vendor verification" ON public.vendor_verification;
CREATE POLICY "Public can insert vendor verification"
  ON public.vendor_verification
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Public can update vendor verification" ON public.vendor_verification;
CREATE POLICY "Public can update vendor verification"
  ON public.vendor_verification
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
