-- Bypass app_config insert trigger (same pattern as previous config migrations)
SET app.via_admin_rpc = 'true';

INSERT INTO public.app_config (key, value) VALUES
  ('vendor_trial_days', '30'),
  ('vendor_grace_period_days', '3'),
  ('vendor_subscription_price', '99'),
  ('global_billing_start_date', '')
ON CONFLICT (key) DO NOTHING;

RESET app.via_admin_rpc;
