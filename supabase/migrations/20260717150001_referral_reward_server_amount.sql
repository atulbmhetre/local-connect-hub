-- Referral ledger hardening:
-- 1) record_user_referral_reward always credits app_config.referral_user_credit
--    (ignores caller-supplied p_credit_amount; param kept for API compatibility).
-- 2) No DB change required for process-vendor-referral phone/vendor rate limits
--    (edge function uses existing check_and_log_rate_limit).

CREATE OR REPLACE FUNCTION public.record_user_referral_reward(
  p_referrer_vendor_id uuid,
  p_user_phone text,
  p_credit_amount numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_referral_id uuid;
  v_amount numeric;
  v_raw text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  -- Never trust p_credit_amount from the client. Always use app_config.
  SELECT NULLIF(trim(ac.value), '')
  INTO v_raw
  FROM public.app_config ac
  WHERE ac.key = 'referral_user_credit'
  LIMIT 1;

  BEGIN
    v_amount := NULLIF(v_raw, '')::numeric;
  EXCEPTION WHEN others THEN
    v_amount := NULL;
  END;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    v_amount := 2.5;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v WHERE v.id = p_referrer_vendor_id
  ) THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  INSERT INTO public.referrals (
    referrer_vendor_id,
    referee_type,
    referee_id,
    status,
    trigger_rule,
    triggered_at,
    credits_created
  )
  VALUES (
    p_referrer_vendor_id,
    'user',
    v_phone,
    'active',
    'active_once',
    now(),
    false
  )
  RETURNING id INTO v_referral_id;

  INSERT INTO public.vendor_credits (
    vendor_id,
    referral_id,
    amount,
    disbursement_month,
    disbursed
  )
  VALUES (
    p_referrer_vendor_id,
    v_referral_id,
    v_amount,
    1,
    false
  );

  UPDATE public.referrals
  SET credits_created = true
  WHERE id = v_referral_id;

  RETURN v_referral_id;
END;
$$;

COMMENT ON FUNCTION public.record_user_referral_reward(uuid, text, numeric) IS
  'Creates user referral + vendor credit. Amount always from app_config.referral_user_credit; p_credit_amount is ignored.';

REVOKE ALL ON FUNCTION public.record_user_referral_reward(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_user_referral_reward(uuid, text, numeric)
  TO anon, authenticated, service_role;
