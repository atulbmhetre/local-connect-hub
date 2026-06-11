-- Seed vendor referral credit amounts (defaults match useAppConfig.ts / process-vendor-referral).
INSERT INTO public.app_config (key, value)
VALUES
  ('referral_vendor_credit_total', '25'),
  ('referral_vendor_credit_m1', '8.34'),
  ('referral_vendor_credit_m2', '8.34'),
  ('referral_vendor_credit_m3', '8.32')
ON CONFLICT (key) DO NOTHING;
