-- RF-REG-20 / RF-REG-21: Seed referral config keys present in useAppConfig defaults
-- but missing from prior migrations (referral_vendor_credit_m* seeded in 20260610020000).

INSERT INTO public.app_config (key, value)
VALUES
  ('referral_enabled', 'true'),
  ('referral_user_credit', '2.5'),
  ('referral_veteran_threshold_months', '12')
ON CONFLICT (key) DO NOTHING;
