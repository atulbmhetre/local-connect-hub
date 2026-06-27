-- Vendors may read app_users.name for customers on their khata ledger (LedgerView display).
-- Phase C app_users_owner restricted SELECT to phone = auth_user_phone(), hiding customer names.

CREATE POLICY app_users_vendor_ledger_select ON public.app_users
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.khata_ledger kl
      INNER JOIN public.vendors v ON v.id = kl.vendor_id
      WHERE kl.user_phone = app_users.phone
        AND v.phone = public.auth_user_phone()
    )
  );
