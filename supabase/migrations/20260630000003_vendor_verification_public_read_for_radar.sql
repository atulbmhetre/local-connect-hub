-- Radar trust badges: customers need latest verification check statuses (not vendor-owned rows only).

CREATE POLICY vendor_verification_public_read_latest ON public.vendor_verification
  FOR SELECT
  TO anon, authenticated
  USING (is_latest IS NOT DISTINCT FROM true);

COMMENT ON POLICY vendor_verification_public_read_latest ON public.vendor_verification IS
  'Radar may read latest verification check statuses to compute trust tier badges for any vendor.';
