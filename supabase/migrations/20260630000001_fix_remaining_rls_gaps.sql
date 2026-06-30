-- Fix remaining Phase C RLS gaps: replace direct anon-client writes with SECURITY DEFINER RPCs.
--
-- vendor_reply_to_review check (20260628000008_fix_remaining_anon_mutations.sql):
--   vendor_reply_to_review IS SECURITY DEFINER — vendor_reviews_vendor_response policy is dropped
--   (vendor updates go through that RPC only; no direct client UPDATE needed).

-- ── 1. submit_feed_reply ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_feed_reply(
  p_post_id uuid,
  p_user_phone text,
  p_content text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_content text;
  v_id uuid;
BEGIN
  v_phone := NULLIF(TRIM(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  v_content := NULLIF(TRIM(p_content), '');
  IF v_content IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feed_posts fp WHERE fp.id = p_post_id) THEN
    RAISE EXCEPTION 'post_not_found';
  END IF;

  INSERT INTO public.feed_replies (post_id, user_phone, content)
  VALUES (p_post_id, v_phone, v_content)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── 2. submit_vendor_review ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_vendor_review(
  p_vendor_id uuid,
  p_request_id uuid,
  p_user_phone text,
  p_device_id text,
  p_rating int,
  p_review_text text,
  p_service_mode text
)
RETURNS public.vendor_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_row public.vendor_reviews;
BEGIN
  v_phone := NULLIF(TRIM(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'invalid_rating';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.vendor_reviews vr WHERE vr.request_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'review_already_exists';
  END IF;

  INSERT INTO public.vendor_reviews (
    vendor_id,
    request_id,
    user_phone,
    device_id,
    rating,
    review_text,
    service_mode
  )
  VALUES (
    p_vendor_id,
    p_request_id,
    v_phone,
    NULLIF(TRIM(p_device_id), ''),
    p_rating,
    NULLIF(TRIM(p_review_text), ''),
    NULLIF(TRIM(p_service_mode), '')
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ── 3. update_vendor_review ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_vendor_review(
  p_review_id uuid,
  p_user_phone text,
  p_rating int,
  p_review_text text
)
RETURNS public.vendor_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_row public.vendor_reviews;
  v_created_at timestamptz;
BEGIN
  v_phone := NULLIF(TRIM(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'invalid_rating';
  END IF;

  SELECT vr.created_at
  INTO v_created_at
  FROM public.vendor_reviews vr
  WHERE vr.id = p_review_id
    AND vr.user_phone = v_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'review_not_found_or_not_owned';
  END IF;

  IF v_created_at < (now() - interval '7 days') THEN
    RAISE EXCEPTION 'review_edit_window_expired';
  END IF;

  UPDATE public.vendor_reviews vr
  SET
    rating = p_rating,
    review_text = NULLIF(TRIM(p_review_text), '')
  WHERE vr.id = p_review_id
    AND vr.user_phone = v_phone
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ── 4. create_referred_user ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_referred_user(
  p_phone text,
  p_device_id text,
  p_referral_code text,
  p_referred_by_vendor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_vendor_phone text;
  v_user_referral_code text;
BEGIN
  v_phone := NULLIF(TRIM(p_phone), '');
  IF v_phone IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.app_users au WHERE au.phone = v_phone) THEN
    RETURN false;
  END IF;

  SELECT v.phone
  INTO v_vendor_phone
  FROM public.vendors v
  WHERE v.id = p_referred_by_vendor_id
    AND upper(trim(v.referral_code)) = upper(trim(p_referral_code));

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF right(regexp_replace(COALESCE(v_vendor_phone, ''), '\D', '', 'g'), 10)
     = right(regexp_replace(v_phone, '\D', '', 'g'), 10) THEN
    RETURN false;
  END IF;

  v_user_referral_code := 'USER' || right(regexp_replace(v_phone, '\D', '', 'g'), 4);

  INSERT INTO public.app_users (
    phone,
    device_id,
    referral_code,
    referred_by_vendor_id
  )
  VALUES (
    v_phone,
    NULLIF(TRIM(p_device_id), ''),
    v_user_referral_code,
    p_referred_by_vendor_id
  );

  RETURN true;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END;
$$;

-- ── 5. vendor_update_customer_name ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_update_customer_name(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_customer_phone text,
  p_name text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_phone text;
  v_customer_phone text;
  v_name text;
BEGIN
  v_customer_phone := NULLIF(TRIM(p_customer_phone), '');
  v_name := NULLIF(TRIM(p_name), '');

  IF v_customer_phone IS NULL OR v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_name_or_phone';
  END IF;

  SELECT v.phone
  INTO v_vendor_phone
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found_or_unauthorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.khata_ledger kl
    WHERE kl.vendor_id = p_vendor_id
      AND kl.user_phone = v_customer_phone
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.requests r
    WHERE r.vendor_id = p_vendor_id
      AND r.user_phone = v_customer_phone
  ) THEN
    RAISE EXCEPTION 'no_vendor_customer_relationship';
  END IF;

  INSERT INTO public.app_users (phone, name)
  VALUES (v_customer_phone, v_name)
  ON CONFLICT (phone)
  DO UPDATE SET name = EXCLUDED.name;

  RETURN true;
END;
$$;

-- ── 6. vendor_record_khata_payment ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_record_khata_payment(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_customer_phone text,
  p_amount numeric,
  p_note text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_phone text;
  v_current_outstanding numeric;
  v_new_outstanding numeric;
BEGIN
  v_customer_phone := NULLIF(TRIM(p_customer_phone), '');
  IF v_customer_phone IS NULL THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'vendor_not_found_or_unauthorized';
  END IF;

  SELECT kl.total_outstanding
  INTO v_current_outstanding
  FROM public.khata_ledger kl
  WHERE kl.vendor_id = p_vendor_id
    AND kl.user_phone = v_customer_phone
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found';
  END IF;

  IF p_amount > v_current_outstanding THEN
    RAISE EXCEPTION 'amount_exceeds_outstanding';
  END IF;

  INSERT INTO public.khata_transactions (
    vendor_id,
    user_phone,
    amount,
    note,
    payment_mode,
    created_at
  )
  VALUES (
    p_vendor_id,
    v_customer_phone,
    p_amount,
    NULLIF(TRIM(p_note), ''),
    'paid',
    now()
  );

  v_new_outstanding := GREATEST(0, v_current_outstanding - p_amount);

  UPDATE public.khata_ledger kl
  SET
    total_outstanding = v_new_outstanding,
    last_updated = now()
  WHERE kl.vendor_id = p_vendor_id
    AND kl.user_phone = v_customer_phone;

  RETURN v_new_outstanding;
END;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.submit_feed_reply(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_feed_reply(uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.submit_vendor_review(uuid, uuid, text, text, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_vendor_review(uuid, uuid, text, text, int, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.update_vendor_review(uuid, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_vendor_review(uuid, text, int, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.create_referred_user(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_referred_user(text, text, text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_update_customer_name(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_customer_name(uuid, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_record_khata_payment(uuid, text, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_record_khata_payment(uuid, text, text, numeric, text) TO anon, authenticated;

-- ── 7. Tighten RLS ─────────────────────────────────────────────────────────

-- feed_replies: writes via submit_feed_reply only (delete policy kept for owner delete if used)
DROP POLICY IF EXISTS feed_replies_owner_insert ON public.feed_replies;

-- vendor_reviews: writes via submit_vendor_review / update_vendor_review / vendor_reply_to_review
DROP POLICY IF EXISTS vendor_reviews_customer_insert ON public.vendor_reviews;
DROP POLICY IF EXISTS vendor_reviews_vendor_response ON public.vendor_reviews;

-- app_users: writes via create_referred_user / vendor_update_customer_name only
DROP POLICY IF EXISTS app_users_owner ON public.app_users;

CREATE POLICY app_users_owner_select ON public.app_users
  FOR SELECT
  TO anon, authenticated
  USING (phone = public.auth_user_phone());

-- khata_ledger: vendor writes via vendor_record_khata_payment / insert_bill_with_items only
DROP POLICY IF EXISTS khata_ledger_vendor ON public.khata_ledger;

CREATE POLICY khata_ledger_vendor ON public.khata_ledger
  FOR SELECT
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT id FROM public.vendors WHERE phone = public.auth_user_phone()
    )
  );

-- ── 8. admin_get_user_lang ───────────────────────────────────────────────────
-- Admin auth matches 20260618000006: public.is_admin_phone(p_admin_phone).

CREATE OR REPLACE FUNCTION public.admin_get_user_lang(
  p_admin_phone text,
  p_user_phone text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lang text;
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT au.lang
  INTO v_lang
  FROM public.app_users au
  WHERE au.phone = NULLIF(TRIM(p_user_phone), '');

  RETURN COALESCE(NULLIF(TRIM(v_lang), ''), 'en');
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_user_lang(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_user_lang(text, text) TO anon, authenticated;
