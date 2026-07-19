-- Admin config ops keys + FCM grant hardening (TEST follow-up to 20260719120001):
-- 1) Expand admin_update_app_config whitelist with 7 operational keys.
-- 2) Backfill app_config.default_value (and missing rows) for all whitelisted keys
--    so Admin App Config never lacks a factory default annotation.
-- 3) REVOKE PUBLIC EXECUTE on get_admin_fcm_failure_stats (anon was inheriting
--    via PUBLIC after the prior anon-only revoke).

-- ── 1. admin_update_app_config: expanded whitelist ────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_update_app_config(
  p_admin_phone text,
  p_key text,
  p_value text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Server-side mirror of ADMIN_CONFIG_WHITELIST in src/pages/Settings.tsx.
  -- Keep BOTH lists in sync when adding a key.
  v_whitelist text[] := ARRAY[
    -- Referral + order expiry / near-deadline
    'referral_enabled',
    'help_accept_timeout_hours',
    'help_accept_timeout_minutes',
    'help_near_deadline_minutes',
    'delivery_near_deadline_minutes',
    'appointment_near_deadline_minutes',
    'appointment_accept_timeout_hours',
    -- Vendor behaviour
    'vendor_stopped_minutes',
    'vendor_stopped_distance_meters',
    'max_order_message_chars',
    -- Referral credits
    'referral_user_credit',
    'referral_vendor_credit_total',
    'referral_vendor_credit_m1',
    'referral_vendor_credit_m2',
    'referral_vendor_credit_m3',
    'referral_veteran_threshold_months',
    -- Business / calls
    'vendor_trial_days',
    'vendor_subscription_price',
    'help_call_limit_seconds',
    'delivery_call_limit_seconds',
    'appointment_call_limit_seconds',
    -- Feature flags
    'vendor_lead_notify_enabled',
    'localization_enabled',
    'lang_hindi_enabled',
    'lang_marathi_enabled',
    'exotel_secure_calling_enabled',
    -- AI
    'ai_category_confidence_threshold',
    -- App
    'dev_menu_pin',
    'feed_notification_radius_km',
    'app_base_url',
    -- Operational (payments / KYC / alerts / grace / khata)
    'payments_enabled',
    'razorpay_key_id',
    'razorpay_kyc_date',
    'exotel_kyc_date',
    'exotel_credits_low_threshold_inr',
    'vendor_grace_period_days',
    'khata_amber_limit'
  ];
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF NULLIF(trim(p_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid key';
  END IF;
  IF NOT (trim(p_key) = ANY (v_whitelist)) THEN
    RAISE EXCEPTION 'key_not_allowed';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  INSERT INTO public.app_config (key, value)
  VALUES (trim(p_key), coalesce(p_value, ''))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON FUNCTION public.admin_update_app_config(text, text, text) IS
  'Admin app_config upsert; server-side whitelist mirrors ADMIN_CONFIG_WHITELIST in Settings.tsx (key_not_allowed otherwise).';

-- ── 2. Backfill default_value (+ insert missing call-limit rows) ───────────────

SET app.via_admin_rpc = 'true';

INSERT INTO public.app_config (key, value, default_value) VALUES
  ('delivery_call_limit_seconds', '120', '120'),
  ('appointment_call_limit_seconds', '180', '180')
ON CONFLICT (key) DO UPDATE
  SET default_value = COALESCE(public.app_config.default_value, EXCLUDED.default_value);

UPDATE public.app_config SET default_value = 'true' WHERE key = 'referral_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '2' WHERE key = 'help_accept_timeout_hours' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '120' WHERE key = 'help_accept_timeout_minutes' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '30' WHERE key = 'help_near_deadline_minutes' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '30' WHERE key = 'delivery_near_deadline_minutes' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '30' WHERE key = 'appointment_near_deadline_minutes' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '2' WHERE key = 'appointment_accept_timeout_hours' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '10' WHERE key = 'vendor_stopped_minutes' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '200' WHERE key = 'vendor_stopped_distance_meters' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '200' WHERE key = 'max_order_message_chars' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '2.5' WHERE key = 'referral_user_credit' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '25' WHERE key = 'referral_vendor_credit_total' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '8.34' WHERE key = 'referral_vendor_credit_m1' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '8.34' WHERE key = 'referral_vendor_credit_m2' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '8.32' WHERE key = 'referral_vendor_credit_m3' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '12' WHERE key = 'referral_veteran_threshold_months' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '30' WHERE key = 'vendor_trial_days' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '99' WHERE key = 'vendor_subscription_price' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '300' WHERE key = 'help_call_limit_seconds' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '120' WHERE key = 'delivery_call_limit_seconds' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '180' WHERE key = 'appointment_call_limit_seconds' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'true' WHERE key = 'vendor_lead_notify_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'true' WHERE key = 'localization_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'true' WHERE key = 'lang_hindi_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'true' WHERE key = 'lang_marathi_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'false' WHERE key = 'exotel_secure_calling_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '0.85' WHERE key = 'ai_category_confidence_threshold' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '1947' WHERE key = 'dev_menu_pin' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '5' WHERE key = 'feed_notification_radius_km' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'https://aaspaas.in' WHERE key = 'app_base_url' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = 'false' WHERE key = 'payments_enabled' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '' WHERE key = 'razorpay_key_id' AND default_value IS NULL;
UPDATE public.app_config SET default_value = '2026-06-28' WHERE key = 'razorpay_kyc_date' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '2026-06-28' WHERE key = 'exotel_kyc_date' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '200' WHERE key = 'exotel_credits_low_threshold_inr' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '3' WHERE key = 'vendor_grace_period_days' AND (default_value IS NULL OR trim(default_value) = '');
UPDATE public.app_config SET default_value = '0' WHERE key = 'khata_amber_limit' AND (default_value IS NULL OR trim(default_value) = '');

RESET app.via_admin_rpc;

-- ── 3. FCM stats: revoke PUBLIC (closes anon inheritance gap) ─────────────────

REVOKE ALL ON FUNCTION public.get_admin_fcm_failure_stats(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_fcm_failure_stats(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_fcm_failure_stats(integer) TO authenticated, service_role;
