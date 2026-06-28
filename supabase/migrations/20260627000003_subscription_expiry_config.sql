-- Subscription and service expiry dates for Atul's monitoring
SET app.via_admin_rpc = 'true';

INSERT INTO public.app_config (key, value, description) VALUES
  ('supabase_plan_renewal', '2027-06-01', 'Supabase Pro plan renewal date — update when renewed'),
  ('domain_renewal_aaspaaspro_com', '2028-06-21', 'aaspaaspro.com domain expiry — 3 year from purchase June 2026'),
  ('domain_renewal_aaspaaspro_in', '2028-06-21', 'aaspaaspro.in domain expiry — 3 year from purchase June 2026'),
  ('razorpay_kyc_date', '2026-06-28', 'Razorpay KYC submission date — update when approved'),
  ('exotel_kyc_date', '2026-06-28', 'Exotel KYC submission date — update when approved'),
  ('anthropic_credits_low_threshold_usd', '2', 'Alert when Anthropic credits drop below this USD amount'),
  ('exotel_credits_low_threshold_inr', '200', 'Alert when Exotel credits drop below this INR amount')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;

RESET app.via_admin_rpc;
