SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value) VALUES
  ('razorpay_key_id', ''),
  ('payments_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
RESET app.via_admin_rpc;
