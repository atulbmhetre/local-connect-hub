-- Document fallback defaults for app_config keys (admin UI + code fallbacks).

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS default_value text;

COMMENT ON COLUMN public.app_config.default_value IS
  'Factory default when value is NULL or empty. Shown in admin config UI.';

UPDATE public.app_config SET default_value = 'true' WHERE key = 'referral_enabled' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '2' WHERE key = 'help_accept_timeout_hours' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '120' WHERE key = 'help_accept_timeout_minutes' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '30' WHERE key = 'help_near_deadline_minutes' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '30' WHERE key = 'delivery_near_deadline_minutes' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '30' WHERE key = 'appointment_near_deadline_minutes' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '2' WHERE key = 'appointment_accept_timeout_hours' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '10' WHERE key = 'vendor_stopped_minutes' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '200' WHERE key = 'vendor_stopped_distance_meters' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '60' WHERE key = 'location_ping_seconds' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '200' WHERE key = 'max_order_message_chars' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '2.5' WHERE key = 'referral_user_credit' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '25' WHERE key = 'referral_vendor_credit_total' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '8.34' WHERE key = 'referral_vendor_credit_m1' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '8.34' WHERE key = 'referral_vendor_credit_m2' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '8.32' WHERE key = 'referral_vendor_credit_m3' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '12' WHERE key = 'referral_veteran_threshold_months' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '30' WHERE key = 'vendor_trial_days' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '99' WHERE key = 'vendor_subscription_price' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '300' WHERE key = 'help_call_limit_seconds' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '120' WHERE key = 'delivery_call_limit_seconds' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '180' WHERE key = 'appointment_call_limit_seconds' AND default_value IS NULL;
UPDATE public.app_config SET default_value = 'true' WHERE key = 'vendor_lead_notify_enabled' AND default_value IS NULL;
UPDATE public.app_config SET default_value = 'true' WHERE key = 'localization_enabled' AND default_value IS NULL;
UPDATE public.app_config SET default_value = 'true' WHERE key = 'lang_hindi_enabled' AND default_value IS NULL;
UPDATE public.app_config SET default_value = 'true' WHERE key = 'lang_marathi_enabled' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '0.85' WHERE key = 'ai_category_confidence_threshold' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '1947' WHERE key = 'dev_menu_pin' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '5' WHERE key = 'feed_notification_radius_km' AND default_value IS NULL;
UPDATE public.app_config SET default_value = 'https://aaspaas.in' WHERE key = 'app_base_url' AND default_value IS NULL;

UPDATE public.app_config
SET value = 'https://aaspaas.in'
WHERE key = 'app_base_url'
  AND (value IS NULL OR trim(value) = '');

SET app.via_admin_rpc = 'true';

INSERT INTO public.app_config (key, value, default_value)
VALUES ('app_base_url', 'https://aaspaas.in', 'https://aaspaas.in')
ON CONFLICT (key) DO NOTHING;

RESET app.via_admin_rpc;
