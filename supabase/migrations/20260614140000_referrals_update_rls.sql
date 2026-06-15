-- RF-REG: anon UPDATE on referrals — recordUserReferral() sets credits_created=true after credit insert.

DROP POLICY IF EXISTS "referrals_update" ON public.referrals;

CREATE POLICY "referrals_update"
  ON public.referrals
  FOR UPDATE
  TO anon
  USING (true);
