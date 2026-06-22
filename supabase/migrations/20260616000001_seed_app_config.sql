-- Seed app_config keys expected by tests / admin whitelist when missing.
-- ON CONFLICT DO NOTHING: never overwrite existing TEST/PROD values.

INSERT INTO public.app_config (key, value)
VALUES
  ('help_accept_timeout_hours', '2'),
  ('help_accept_timeout_minutes', '120'),
  ('near_deadline_warning_minutes', '30'),
  ('referral_enabled', 'true'),
  ('vendor_lead_notify_enabled', 'true'),
  ('localization_enabled', 'true'),
  ('lang_hindi_enabled', 'true'),
  ('lang_marathi_enabled', 'true'),
  ('ai_category_confidence_threshold', '0.7'),
  ('app_base_url', 'https://aaspaas.in'),
  ('admin_phone', '8888169446'),
  ('khata_amber_limit', '0'),
  ('vendor_stopped_distance_meters', '50'),
  ('max_order_message_chars', '500')
ON CONFLICT (key) DO NOTHING;
