-- Fix 2 (ledger): drop broken app_users SELECT policy; vendor names via explicit phone RPC.
-- (UPI RPC fix was applied in 20260628000010; this migration adds the ledger companion.)

DROP POLICY IF EXISTS app_users_vendor_ledger_select ON public.app_users;

CREATE OR REPLACE FUNCTION public.get_vendor_customer_names(
  p_vendor_phone text
)
RETURNS TABLE(phone text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    kl.user_phone AS phone,
    NULLIF(TRIM(au.name), '') AS name
  FROM public.khata_ledger kl
  INNER JOIN public.vendors v ON v.id = kl.vendor_id
  LEFT JOIN public.app_users au ON au.phone = kl.user_phone
  WHERE v.phone = p_vendor_phone
    AND kl.user_phone IS NOT NULL;
$$;

COMMENT ON FUNCTION public.get_vendor_customer_names(text) IS
  'Returns customer phone/name pairs for a vendor khata ledger. SECURITY DEFINER — bypasses app_users RLS while OTP auth is disabled.';

REVOKE ALL ON FUNCTION public.get_vendor_customer_names(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_customer_names(text) TO anon, authenticated;
