-- M2: bound address text length (client MAX_ADDRESS_TEXT_CHARS = 500).
-- M4: vendor_mark_bill_paid requires unpaid status (no silent paid_at refresh).
-- M11: apply_user_referral refuses banned / deletion-scheduled referrer vendors.

-- ── M2: address length CHECKs ────────────────────────────────────────────────

UPDATE public.user_addresses
SET address_text = left(address_text, 500)
WHERE char_length(address_text) > 500;

UPDATE public.requests
SET delivery_address = left(delivery_address, 500)
WHERE delivery_address IS NOT NULL AND char_length(delivery_address) > 500;

UPDATE public.recurring_orders
SET delivery_address = left(delivery_address, 500)
WHERE delivery_address IS NOT NULL AND char_length(delivery_address) > 500;

ALTER TABLE public.user_addresses
  DROP CONSTRAINT IF EXISTS user_addresses_address_text_max_len;

ALTER TABLE public.user_addresses
  ADD CONSTRAINT user_addresses_address_text_max_len
  CHECK (char_length(address_text) <= 500);

ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_delivery_address_max_len;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_delivery_address_max_len
  CHECK (delivery_address IS NULL OR char_length(delivery_address) <= 500);

ALTER TABLE public.recurring_orders
  DROP CONSTRAINT IF EXISTS recurring_orders_delivery_address_max_len;

ALTER TABLE public.recurring_orders
  ADD CONSTRAINT recurring_orders_delivery_address_max_len
  CHECK (delivery_address IS NULL OR char_length(delivery_address) <= 500);

-- ── M4: unpaid precondition on vendor_mark_bill_paid ─────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_mark_bill_paid(
  p_bill_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  UPDATE public.order_bills ob
  SET payment_status = 'paid', paid_at = now()
  FROM public.vendors v
  WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id
    AND ob.payment_status = 'unpaid'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.order_bills ob
      JOIN public.vendors v ON v.id = ob.vendor_id
      WHERE ob.id = p_bill_id
        AND ob.vendor_id = p_vendor_id
        AND v.phone = p_vendor_phone
        AND ob.payment_status IS DISTINCT FROM 'unpaid'
    ) THEN
      RAISE EXCEPTION 'bill_not_unpaid';
    END IF;
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_mark_bill_paid(uuid, uuid, text) IS
  'Vendor marks an unpaid bill paid. Refuses already-paid/claimed bills (bill_not_unpaid). Soft hybrid session check.';

REVOKE ALL ON FUNCTION public.vendor_mark_bill_paid(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_mark_bill_paid(uuid, uuid, text)
  TO anon, authenticated, service_role;

-- ── M11: referrer ban / deletion gate on apply_user_referral ─────────────────

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
  v_vendor_banned boolean;
  v_vendor_deletion_requested_at timestamptz;
  v_referred_by uuid;
  v_user_exists boolean := false;
  v_referral_id uuid;
  v_amount numeric;
  v_raw text;
BEGIN
  PERFORM public._assert_session_matches_claimed_phone(p_phone);

  v_phone := NULLIF(trim(p_phone), '');
  v_code := NULLIF(upper(trim(p_referral_code)), '');
  IF v_phone IS NULL OR v_code IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'missing_input');
  END IF;

  SELECT
    v.id,
    v.phone,
    COALESCE(v.is_banned, false),
    v.deletion_requested_at
  INTO
    v_vendor_id,
    v_vendor_phone,
    v_vendor_banned,
    v_vendor_deletion_requested_at
  FROM public.vendors v
  WHERE upper(trim(v.referral_code)) = v_code;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'invalid_code');
  END IF;

  IF v_vendor_banned THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'referrer_banned');
  END IF;

  IF v_vendor_deletion_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'referrer_deletion_scheduled');
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
    IF v_referred_by IS DISTINCT FROM v_vendor_id THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'user_exists');
    END IF;
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
  'Atomic apply referral for joining user phone. Soft hybrid session check. Refuses banned or deletion-scheduled referrer vendors.';

REVOKE ALL ON FUNCTION public.apply_user_referral(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_user_referral(text, text, text)
  TO anon, authenticated, service_role;
