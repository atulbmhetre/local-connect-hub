-- vendors table RLS was enabled directly in the Supabase dashboard with permissive
-- policies but never codified in migrations (VR-REG-14).
-- Probed live on 2026-06-14:
--   TEST (hhdylnhqdzfabsolwxdz):
--     • anon_all — ALL — anon — USING (true) — WITH CHECK (true)
--   PROD (rpxsyeqskvhjmbkxnpmd):
--     • Public Access — ALL — PUBLIC (all roles) — USING (true) — WITH CHECK (true)
-- App runs entirely as anon (src/lib/supabase.ts, no auth session). Both policies
-- are permissive; expressions are identical. Codify PROD policy name/body and drop
-- the legacy TEST policy name so db push is idempotent on both environments.

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all" ON public.vendors;
DROP POLICY IF EXISTS "Public Access" ON public.vendors;
CREATE POLICY "Public Access"
  ON public.vendors
  FOR ALL
  USING (true)
  WITH CHECK (true);
