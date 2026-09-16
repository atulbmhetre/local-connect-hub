-- Dormant UPI VPA verification (Decentro VerifyPay / Decfin) — Razorpay-style two-layer gate.
-- Client: app_config.upi_verification_enabled default false (coming-soon).
-- Edge: compile-time UPI_VERIFICATION_ENABLED=false; going live needs a redeploy.
-- Do not put Decentro ids or bank names in vendor_verification.notes (publicly readable).
-- Success/failure is written via _upsert_vendor_verification_status(..., 'upi_pennydrop', ...).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
--
-- API: VerifyPay v3 POST /v3/banking/verify_pay (not BAV v3 validate_bank_account).
-- Secrets (Dashboard only): DECENTRO_DECFIN_CLIENT_ID, DECENTRO_DECFIN_CLIENT_SECRET,
-- DECENTRO_DECFIN_CONSUMER_URN (Master Consumer URN for the Decfin / aaspaaspro_staging
-- Client ID). The BAV v3 Consumer URN is a different identifier for account+IFSC
-- validation and is not used here.

-- ── client flag ────────────────────────────────────────────────────────────
SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value)
VALUES ('upi_verification_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
RESET app.via_admin_rpc;

-- ── admin whitelist: allow flipping the flag later (also add aadhaar, already in UI) ──
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
  v_whitelist text[] := ARRAY[
    'referral_enabled',
    'help_accept_timeout_hours',
    'help_accept_timeout_minutes',
    'help_near_deadline_minutes',
    'delivery_near_deadline_minutes',
    'appointment_near_deadline_minutes',
    'appointment_accept_timeout_hours',
    'vendor_stopped_minutes',
    'vendor_stopped_distance_meters',
    'max_order_message_chars',
    'referral_user_credit',
    'referral_vendor_credit_total',
    'referral_vendor_credit_m1',
    'referral_vendor_credit_m2',
    'referral_vendor_credit_m3',
    'referral_veteran_threshold_months',
    'vendor_trial_days',
    'vendor_subscription_price',
    'help_call_limit_seconds',
    'delivery_call_limit_seconds',
    'appointment_call_limit_seconds',
    'vendor_lead_notify_enabled',
    'localization_enabled',
    'lang_hindi_enabled',
    'lang_marathi_enabled',
    'exotel_secure_calling_enabled',
    'aadhaar_verification_enabled',
    'upi_verification_enabled',
    'ai_category_confidence_threshold',
    'feed_notification_radius_km',
    'app_base_url',
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
  'Admin app_config upsert; server-side whitelist mirrors ADMIN_CONFIG_WHITELIST in AdminConsole.tsx (key_not_allowed otherwise).';

-- ── service-role ledger: txn ref + matched name only (no raw payload / account no.) ──
CREATE TABLE IF NOT EXISTS public.vendor_upi_pennydrop_txns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  reference_id text NOT NULL,
  decentro_txn_id text NULL,
  matched_account_holder_name text NULL,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'passed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT vendor_upi_pennydrop_txns_reference_id_unique UNIQUE (reference_id)
);

COMMENT ON TABLE public.vendor_upi_pennydrop_txns IS
  'Service-role only. Stores Decentro VerifyPay txn id and matched account-holder name. Never raw API payloads or account numbers.';

COMMENT ON COLUMN public.vendor_upi_pennydrop_txns.reference_id IS
  'Our unique id sent to Decentro as reference_id.';

COMMENT ON COLUMN public.vendor_upi_pennydrop_txns.decentro_txn_id IS
  'Decentro decentro_txn_id from VerifyPay. Proof the check was attempted.';

COMMENT ON COLUMN public.vendor_upi_pennydrop_txns.matched_account_holder_name IS
  'name_as_per_bank from VerifyPay, used for name-match against vendors.name.';

CREATE INDEX IF NOT EXISTS vendor_upi_pennydrop_txns_vendor_id_idx
  ON public.vendor_upi_pennydrop_txns (vendor_id, created_at DESC);

ALTER TABLE public.vendor_upi_pennydrop_txns ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_upi_pennydrop_txns FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_upi_pennydrop_txns FROM anon, authenticated;
GRANT ALL ON TABLE public.vendor_upi_pennydrop_txns TO service_role;

GRANT EXECUTE ON FUNCTION public._upsert_vendor_verification_status(uuid, text, text, text)
  TO service_role;
