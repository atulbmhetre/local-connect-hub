-- Restrict public app_config reads so secrets/PII are not world-readable,
-- and rotate upi_alert_hook_secret (the previous value was SELECT-able by anon).
-- The hook secret stays in app_config because _finish_vendor_upi_mutation
-- (SECURITY DEFINER) and notify-upi-change (service_role) still need it.
-- Emptying the row would 401 UPI-change SMS. admin_phone stays for
-- is_admin_phone(); it is no longer anon-readable.

DROP POLICY IF EXISTS app_config_public_read ON public.app_config;

CREATE POLICY app_config_public_read ON public.app_config
  FOR SELECT
  TO anon, authenticated
  USING (
    key NOT IN (
      'admin_phone',
      'anon_key',
      'edge_function_url',
      'service_role_key',
      'upi_alert_hook_secret'
    )
  );

COMMENT ON POLICY app_config_public_read ON public.app_config IS
  'Public feature flags only. Secrets, admin_phone, anon_key, and edge_function_url are service_role / SECURITY DEFINER.';

SET app.via_admin_rpc = 'true';

UPDATE public.app_config
SET value = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE key = 'upi_alert_hook_secret';

INSERT INTO public.app_config (key, value)
SELECT 'upi_alert_hook_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_config WHERE key = 'upi_alert_hook_secret'
);

RESET app.via_admin_rpc;
