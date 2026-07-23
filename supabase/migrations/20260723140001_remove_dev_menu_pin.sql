-- Remove public client-side PIN gate for Settings "Set phone number (dev)".
-- That control is now gated by is_admin_session() in the Admin tab UI only.
-- 1) Drop dev_menu_pin from admin_update_app_config whitelist (mirror Settings.tsx).
-- 2) Delete the app_config row (via_admin_rpc bypass for the insert/delete guard).

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

SET app.via_admin_rpc = 'true';
DELETE FROM public.app_config WHERE key = 'dev_menu_pin';
RESET app.via_admin_rpc;
