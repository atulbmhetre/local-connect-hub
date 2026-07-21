-- Referral remaining-dimensions fixes (Session 2026-07-21):
--
-- 1) apply_user_referral: single atomic RPC replacing the client-side
--    create_referred_user -> record_user_referral_reward two-step.
--    Fixes the create-success/reward-fail trap: if a previous attempt created
--    the app_users row (referred_by_vendor_id set) but the reward step failed,
--    a retry now completes the reward instead of silently no-op'ing on
--    "user already exists". Dedupes on an existing referrals row, so retries
--    can never double-credit (record_user_referral_reward alone had no dedupe).
--
-- 2) Returns the referrer vendor's own language (app_users.lang via
--    resolve_user_lang on the vendor's phone) so the client can word the
--    vendor's "you earned credit" notification in the VENDOR's language,
--    not the joining user's device language.
--
-- Existing RPCs create_referred_user / record_user_referral_reward are kept
-- unchanged for API compatibility (tests + any stale clients).

CREATE OR REPLACE FUNCTION public.apply_user_referral(
  p_phone text,
  p_device_id text,
  p_referral_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_code text;
  v_vendor_id uuid;
  v_vendor_phone text;
  v_referred_by uuid;
  v_user_exists boolean := false;
  v_referral_id uuid;
  v_amount numeric;
  v_raw text;
BEGIN
  v_phone := NULLIF(trim(p_phone), '');
  v_code := NULLIF(upper(trim(p_referral_code)), '');
  IF v_phone IS NULL OR v_code IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'missing_input');
  END IF;

  SELECT v.id, v.phone
  INTO v_vendor_id, v_vendor_phone
  FROM public.vendors v
  WHERE upper(trim(v.referral_code)) = v_code;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'invalid_code');
  END IF;

  -- Self-referral block (same last-10-digit rule as create_referred_user).
  IF right(regexp_replace(COALESCE(v_vendor_phone, ''), '\D', '', 'g'), 10)
     = right(regexp_replace(v_phone, '\D', '', 'g'), 10) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'self_referral');
  END IF;

  SELECT true, au.referred_by_vendor_id
  INTO v_user_exists, v_referred_by
  FROM public.app_users au
  WHERE au.phone = v_phone;

  IF v_user_exists THEN
    -- Existing user who was NOT created via this vendor's referral: ineligible.
    IF v_referred_by IS DISTINCT FROM v_vendor_id THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'user_exists');
    END IF;
    -- Created via this referral: only proceed if the reward step is still
    -- missing (the create-success/reward-fail retry path).
    IF EXISTS (
      SELECT 1 FROM public.referrals r
      WHERE r.referrer_vendor_id = v_vendor_id
        AND r.referee_type = 'user'
        AND r.referee_id = v_phone
    ) THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'already_rewarded');
    END IF;
  ELSE
    INSERT INTO public.app_users (
      phone,
      device_id,
      referral_code,
      referred_by_vendor_id
    )
    VALUES (
      v_phone,
      NULLIF(trim(p_device_id), ''),
      'USER' || right(regexp_replace(v_phone, '\D', '', 'g'), 4),
      v_vendor_id
    );
  END IF;

  -- Amount always from app_config (same rule as record_user_referral_reward).
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
    v_vendor_id,
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
    v_vendor_id,
    v_referral_id,
    v_amount,
    1,
    false
  );

  UPDATE public.referrals
  SET credits_created = true
  WHERE id = v_referral_id;

  RETURN jsonb_build_object(
    'applied', true,
    'vendor_id', v_vendor_id,
    'referral_id', v_referral_id,
    'credit_amount', v_amount,
    'vendor_lang', public.resolve_user_lang(v_vendor_phone)
  );
END;
$$;

COMMENT ON FUNCTION public.apply_user_referral(text, text, text) IS
  'Atomic user-referral apply: creates the referred app_user if missing and records the reward, completing the reward on retry when a prior attempt created the user but failed the reward step. Dedupes on referrals; amount from app_config.referral_user_credit; returns the referrer''s own lang for recipient-correct notification copy.';

REVOKE ALL ON FUNCTION public.apply_user_referral(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_user_referral(text, text, text)
  TO anon, authenticated, service_role;
