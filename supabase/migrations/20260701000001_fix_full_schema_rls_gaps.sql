-- Phase C RLS gap fixes: anon/localStorage clients cannot satisfy auth_user_phone() policies.
-- Extends vendor_update_own and adds RPCs for remaining direct mutations.

-- ── 1. vendor_update_own (extended patch fields) ─────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_update_own(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'patch_required';
  END IF;

  UPDATE public.vendors v
  SET
    vendor_note = CASE WHEN p_patch ? 'vendor_note' THEN NULLIF(p_patch->>'vendor_note', '') ELSE v.vendor_note END,
    service_radius_km = CASE WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::integer ELSE v.service_radius_km END,
    latitude = CASE WHEN p_patch ? 'latitude' THEN (p_patch->>'latitude')::double precision ELSE v.latitude END,
    longitude = CASE WHEN p_patch ? 'longitude' THEN (p_patch->>'longitude')::double precision ELSE v.longitude END,
    profile_status = CASE WHEN p_patch ? 'profile_status' THEN p_patch->>'profile_status' ELSE v.profile_status END,
    ledger_cycle_start = CASE
      WHEN p_patch ? 'ledger_cycle_start' AND p_patch->'ledger_cycle_start' IS NULL THEN NULL
      WHEN p_patch ? 'ledger_cycle_start' THEN (p_patch->>'ledger_cycle_start')::date
      ELSE v.ledger_cycle_start
    END,
    khata_amber_limit = CASE WHEN p_patch ? 'khata_amber_limit' THEN (p_patch->>'khata_amber_limit')::numeric ELSE v.khata_amber_limit END,
    khata_red_limit = CASE WHEN p_patch ? 'khata_red_limit' THEN (p_patch->>'khata_red_limit')::numeric ELSE v.khata_red_limit END,
    cancel_reason_1 = CASE WHEN p_patch ? 'cancel_reason_1' THEN NULLIF(p_patch->>'cancel_reason_1', '') ELSE v.cancel_reason_1 END,
    cancel_reason_2 = CASE WHEN p_patch ? 'cancel_reason_2' THEN NULLIF(p_patch->>'cancel_reason_2', '') ELSE v.cancel_reason_2 END,
    cancel_reason_3 = CASE WHEN p_patch ? 'cancel_reason_3' THEN NULLIF(p_patch->>'cancel_reason_3', '') ELSE v.cancel_reason_3 END,
    cancel_reason_4 = CASE WHEN p_patch ? 'cancel_reason_4' THEN NULLIF(p_patch->>'cancel_reason_4', '') ELSE v.cancel_reason_4 END,
    subscription_status = CASE WHEN p_patch ? 'subscription_status' THEN p_patch->>'subscription_status' ELSE v.subscription_status END,
    subscription_id = CASE WHEN p_patch ? 'subscription_id' THEN NULLIF(p_patch->>'subscription_id', '') ELSE v.subscription_id END,
    grace_ends_at = CASE
      WHEN p_patch ? 'grace_ends_at' AND p_patch->'grace_ends_at' IS NULL THEN NULL
      WHEN p_patch ? 'grace_ends_at' THEN (p_patch->>'grace_ends_at')::timestamptz
      ELSE v.grace_ends_at
    END,
    last_updated = CASE
      WHEN p_patch ? 'last_updated' THEN (p_patch->>'last_updated')::timestamptz
      ELSE v.last_updated
    END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch->>'is_active')::boolean ELSE v.is_active END,
    fcm_token = CASE WHEN p_patch ? 'fcm_token' THEN NULLIF(p_patch->>'fcm_token', '') ELSE v.fcm_token END,
    shop_name = CASE WHEN p_patch ? 'shop_name' THEN NULLIF(p_patch->>'shop_name', '') ELSE v.shop_name END,
    category = CASE WHEN p_patch ? 'category' THEN NULLIF(p_patch->>'category', '') ELSE v.category END,
    service_mode = CASE WHEN p_patch ? 'service_mode' THEN NULLIF(p_patch->>'service_mode', '') ELSE v.service_mode END,
    vendor_type = CASE WHEN p_patch ? 'vendor_type' THEN NULLIF(p_patch->>'vendor_type', '') ELSE v.vendor_type END,
    phone = CASE WHEN p_patch ? 'phone' THEN NULLIF(p_patch->>'phone', '') ELSE v.phone END,
    upi_id = CASE WHEN p_patch ? 'upi_id' THEN NULLIF(p_patch->>'upi_id', '') ELSE v.upi_id END,
    is_manual_verified = CASE WHEN p_patch ? 'is_manual_verified' THEN (p_patch->>'is_manual_verified')::boolean ELSE v.is_manual_verified END,
    verification_status = CASE WHEN p_patch ? 'verification_status' THEN p_patch->>'verification_status' ELSE v.verification_status END,
    shop_photo_url = CASE
      WHEN p_patch ? 'shop_photo_url' AND p_patch->'shop_photo_url' IS NULL THEN NULL
      WHEN p_patch ? 'shop_photo_url' THEN NULLIF(p_patch->>'shop_photo_url', '')
      ELSE v.shop_photo_url
    END,
    upi_verified = CASE WHEN p_patch ? 'upi_verified' THEN (p_patch->>'upi_verified')::boolean ELSE v.upi_verified END,
    photo_selfie = CASE
      WHEN p_patch ? 'photo_selfie' AND p_patch->'photo_selfie' IS NULL THEN NULL
      WHEN p_patch ? 'photo_selfie' THEN NULLIF(p_patch->>'photo_selfie', '')
      ELSE v.photo_selfie
    END,
    gps_match_distance = CASE WHEN p_patch ? 'gps_match_distance' THEN (p_patch->>'gps_match_distance')::integer ELSE v.gps_match_distance END
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── 2. vendor_promote_green_pending ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_promote_green_pending(p_vendor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendors v
  SET verification_status = 'green_pending'
  WHERE v.id = p_vendor_id
    AND v.verification_status IS DISTINCT FROM 'green_pending'
    AND v.is_manual_verified IS NOT TRUE
    AND v.shop_photo_url IS NOT NULL
    AND v.upi_verified IS TRUE;

  RETURN FOUND;
END;
$$;

-- ── 3. recalculate_vendor_rating_stats ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.recalculate_vendor_rating_stats(
  p_vendor_id uuid,
  p_alert_admin boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review_count integer;
  v_avg_rating numeric;
  v_low_notified boolean;
BEGIN
  SELECT count(*)::integer, round(avg(rating)::numeric, 1)
  INTO v_review_count, v_avg_rating
  FROM public.vendor_reviews vr
  WHERE vr.vendor_id = p_vendor_id;

  IF v_review_count = 0 OR v_avg_rating IS NULL THEN
    UPDATE public.vendors
    SET avg_rating = NULL, review_count = 0, low_rating_admin_notified = false
    WHERE id = p_vendor_id;
    RETURN;
  END IF;

  SELECT low_rating_admin_notified
  INTO v_low_notified
  FROM public.vendors
  WHERE id = p_vendor_id;

  UPDATE public.vendors v
  SET
    avg_rating = v_avg_rating,
    review_count = v_review_count,
    low_rating_admin_notified = CASE
      WHEN v_avg_rating > 3.5 THEN false
      WHEN p_alert_admin AND v_avg_rating < 2.0 AND v_review_count >= 5 AND NOT COALESCE(v_low_notified, false)
        THEN true
      ELSE v.low_rating_admin_notified
    END
  WHERE v.id = p_vendor_id;
END;
$$;

-- ── 4. vendor_mark_customer_khata_bills_paid ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_mark_customer_khata_bills_paid(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_customer_phone text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = p_vendor_id AND v.phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.order_bills ob
  SET payment_status = 'paid', paid_at = now()
  WHERE ob.vendor_id = p_vendor_id
    AND ob.user_phone = trim(p_customer_phone)
    AND ob.payment_mode = 'khata'
    AND ob.payment_status = 'unpaid';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── 5. submit_customer_feed_post ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_customer_feed_post(
  p_user_phone text,
  p_type text,
  p_content text,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_recommended_vendor_id uuid DEFAULT NULL,
  p_recommended_vendor_name text DEFAULT NULL,
  p_recommended_vendor_phone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_id uuid;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF NULLIF(trim(p_content), '') IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  INSERT INTO public.feed_posts (
    user_phone,
    vendor_id,
    type,
    content,
    expires_at,
    image_url,
    lat,
    lng,
    recommended_vendor_id,
    recommended_vendor_name,
    recommended_vendor_phone
  )
  VALUES (
    v_phone,
    NULL,
    NULLIF(trim(p_type), ''),
    trim(p_content),
    p_expires_at,
    NULLIF(trim(p_image_url), ''),
    p_lat,
    p_lng,
    p_recommended_vendor_id,
    NULLIF(trim(p_recommended_vendor_name), ''),
    NULLIF(trim(p_recommended_vendor_phone), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── 6. record_user_referral_reward ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_user_referral_reward(
  p_referrer_vendor_id uuid,
  p_user_phone text,
  p_credit_amount numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_referral_id uuid;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF p_credit_amount IS NULL OR p_credit_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_credit_amount';
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
    p_credit_amount,
    1,
    false
  );

  UPDATE public.referrals
  SET credits_created = true
  WHERE id = v_referral_id;

  RETURN v_referral_id;
END;
$$;

-- ── 7. admin_apply_vendor_waiveoff ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_apply_vendor_waiveoff(
  p_admin_phone text,
  p_vendor_id uuid,
  p_percent integer,
  p_months integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_percent IS NULL OR p_percent <= 0 OR p_percent > 100 THEN
    RAISE EXCEPTION 'invalid_percent';
  END IF;

  IF p_months IS NULL OR p_months <= 0 OR p_months > 12 THEN
    RAISE EXCEPTION 'invalid_months';
  END IF;

  UPDATE public.vendors v
  SET
    waiveoff_percent = p_percent,
    waiveoff_months_remaining = p_months
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;
END;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.vendor_promote_green_pending(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_promote_green_pending(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.recalculate_vendor_rating_stats(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_vendor_rating_stats(uuid, boolean) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_mark_customer_khata_bills_paid(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_mark_customer_khata_bills_paid(uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.submit_customer_feed_post(text, text, text, timestamptz, text, double precision, double precision, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_customer_feed_post(text, text, text, timestamptz, text, double precision, double precision, uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.record_user_referral_reward(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_user_referral_reward(uuid, text, numeric) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_apply_vendor_waiveoff(text, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_apply_vendor_waiveoff(text, uuid, integer, integer) TO anon, authenticated;
