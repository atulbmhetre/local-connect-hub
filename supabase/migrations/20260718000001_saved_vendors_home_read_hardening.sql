-- Home saved-neighbours read hardening (OTP-off identity model).
--
-- Confirmed live on TEST + PROD: saved_vendors has only saved_vendors_owner
-- (user_phone = auth_user_phone()), which returns zero rows for every OTP-off
-- caller (no Supabase Auth session → auth_user_phone() NULL). saved_vendor_removal_notices
-- SELECT was USING (true) — world-readable. This migration:
--   1) Adds get_saved_vendors RPC (caller-supplied phone/device, same pattern as
--      save_saved_vendor / get_vendors_visible_to_customer) so Home can read again.
--   2) Adds get_saved_vendor_removal_notices RPC and REMOVES the open SELECT policy
--      so notices are no longer world-readable.
--   3) Deletes the customer's removal notices during account anonymisation (orphan PII fix).
--   4) Rate-limits save/unsave/migrate saved-vendor mutations (defense-in-depth under OTP-off).
-- RLS on saved_vendors stays restrictive — reads go through the RPC, not USING (true).

-- ── 1. get_saved_vendors: OTP-off own-list read ──────────────────────────────

CREATE OR REPLACE FUNCTION public.get_saved_vendors(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS SETOF public.saved_vendors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  -- Mirror Home's scoping: phone-scoped when a phone is present, else device-scoped.
  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    RETURN QUERY
    SELECT sv.*
    FROM public.saved_vendors sv
    WHERE sv.user_phone = btrim(p_user_phone)
    ORDER BY sv.saved_at DESC;
  ELSE
    RETURN QUERY
    SELECT sv.*
    FROM public.saved_vendors sv
    WHERE sv.device_id = btrim(p_device_id)
    ORDER BY sv.saved_at DESC;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_saved_vendors(text, text) IS
  'Returns the caller''s own saved_vendors by caller-supplied phone (or device when no phone). OTP-off read path; RLS stays restrictive.';

REVOKE ALL ON FUNCTION public.get_saved_vendors(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_saved_vendors(text, text) TO anon, authenticated, service_role;

-- ── 2. saved_vendor_removal_notices: scoped RPC + lock down direct SELECT ─────

-- Remove the world-readable SELECT policy. With RLS enabled and no SELECT policy,
-- anon/authenticated can no longer read the table directly (service_role still bypasses RLS).
DROP POLICY IF EXISTS "saved_vendor_removal_notices_select" ON public.saved_vendor_removal_notices;

CREATE OR REPLACE FUNCTION public.get_saved_vendor_removal_notices(
  p_user_phone text
)
RETURNS SETOF public.saved_vendor_removal_notices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  RETURN QUERY
  SELECT n.*
  FROM public.saved_vendor_removal_notices n
  WHERE n.user_phone = btrim(p_user_phone)
    AND n.shown_at IS NULL
  ORDER BY n.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_saved_vendor_removal_notices(text) IS
  'Returns the caller''s own unshown removal notices. Replaces the removed USING(true) SELECT policy.';

REVOKE ALL ON FUNCTION public.get_saved_vendor_removal_notices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_saved_vendor_removal_notices(text) TO anon, authenticated, service_role;

-- ── 3. Clear removal notices on customer anonymisation (orphan PII fix) ───────
-- Re-create _anonymise_customer_phone (from 20260614000004) with an added delete of
-- the customer's removal notices so real phone + shop_name rows don't survive deletion.

CREATE OR REPLACE FUNCTION public._anonymise_customer_phone(
  p_original_phone text,
  p_anon_tag text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests
  SET
    user_phone = p_anon_tag,
    delivery_address = NULL,
    message = 'Order deleted'
  WHERE user_phone = p_original_phone;

  UPDATE public.vendor_reviews
  SET
    user_phone = p_anon_tag,
    review_text = 'Review deleted'
  WHERE user_phone = p_original_phone;

  UPDATE public.feed_posts
  SET
    user_phone = p_anon_tag,
    content = 'Post deleted',
    lat = NULL,
    lng = NULL
  WHERE user_phone = p_original_phone;

  UPDATE public.feed_posts
  SET
    recommended_vendor_phone = NULL,
    recommended_vendor_id = NULL,
    recommended_vendor_name = NULL
  WHERE user_phone = p_anon_tag;

  UPDATE public.feed_replies
  SET
    user_phone = p_anon_tag,
    content = 'Reply deleted'
  WHERE user_phone = p_original_phone;

  UPDATE public.feed_flags
  SET flagged_by_phone = p_anon_tag
  WHERE flagged_by_phone = p_original_phone;

  UPDATE public.user_flags
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.order_bills
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.khata_ledger
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.khata_transactions
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.referrals
  SET referee_id = p_anon_tag
  WHERE referee_id = p_original_phone
    AND referee_type = 'user';

  -- Remove device-scoped saves before user_devices DELETE
  DELETE FROM public.saved_vendors
  WHERE device_id IN (
    SELECT device_id
    FROM public.user_devices
    WHERE user_phone = p_original_phone
  );

  DELETE FROM public.user_devices
  WHERE user_phone = p_original_phone;

  DELETE FROM public.user_addresses
  WHERE user_phone = p_original_phone;

  DELETE FROM public.user_notifications
  WHERE user_phone = p_original_phone;

  DELETE FROM public.saved_vendors
  WHERE user_phone = p_original_phone;

  -- Clear this customer's own removal notices (real phone + shop_name PII).
  DELETE FROM public.saved_vendor_removal_notices
  WHERE user_phone = p_original_phone;

  DELETE FROM public.app_users
  WHERE phone = p_original_phone;

  UPDATE public.users
  SET phone = p_anon_tag
  WHERE phone = p_original_phone;
END;
$$;

-- ── 4. Rate-limit saved-vendor mutation RPCs (defense-in-depth) ──────────────

CREATE OR REPLACE FUNCTION public.save_saved_vendor(
  p_vendor_id uuid,
  p_category text,
  p_nickname text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('save_saved_vendor', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  INSERT INTO public.saved_vendors (device_id, vendor_id, category, nickname, user_phone)
  VALUES (p_device_id, p_vendor_id, p_category, p_nickname, p_user_phone);
END;
$$;

CREATE OR REPLACE FUNCTION public.unsave_saved_vendor(
  p_vendor_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('unsave_saved_vendor', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  DELETE FROM public.saved_vendors sv
  WHERE sv.vendor_id = p_vendor_id
    AND (
      (p_user_phone IS NOT NULL AND sv.user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND sv.device_id = p_device_id)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.migrate_saved_vendors_phone(
  p_device_id text,
  p_user_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL OR p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit('migrate_saved_vendors_phone', 'device_id', btrim(p_device_id), 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.saved_vendors
  SET user_phone = p_user_phone
  WHERE device_id = p_device_id
    AND (user_phone IS NULL OR user_phone <> p_user_phone);
END;
$$;

-- Grants unchanged (function signatures identical) but re-assert for clarity.
REVOKE ALL ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.unsave_saved_vendor(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unsave_saved_vendor(uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.migrate_saved_vendors_phone(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_saved_vendors_phone(text, text) TO anon, authenticated;
