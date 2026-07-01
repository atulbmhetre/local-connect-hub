-- OTP-off production gaps: SECURITY DEFINER RPCs for mutations blocked by auth_user_phone() RLS.

-- ── Fix 1: upsert_app_user ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_app_user(
  p_phone text,
  p_lang text DEFAULT 'en'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.users (phone, last_active)
  VALUES (v_phone, now())
  ON CONFLICT (phone) DO UPDATE
  SET last_active = EXCLUDED.last_active;

  IF p_lang IS NOT NULL AND p_lang IN ('en', 'hi', 'mr') THEN
    UPDATE public.app_users
    SET lang = p_lang
    WHERE phone = v_phone;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_app_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_app_user(text, text) TO anon, authenticated;

-- ── Fix 2: user_addresses update/delete ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_user_address(
  p_user_phone text,
  p_address_id uuid,
  p_address_text text,
  p_label text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NULLIF(trim(p_address_text), '') IS NULL THEN
    RAISE EXCEPTION 'address_required';
  END IF;

  UPDATE public.user_addresses
  SET
    address_text = trim(p_address_text),
    label = COALESCE(NULLIF(trim(p_label), ''), label)
  WHERE id = p_address_id
    AND user_phone = v_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_user_address(
  p_user_phone text,
  p_address_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  DELETE FROM public.user_addresses
  WHERE id = p_address_id
    AND user_phone = v_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_user_address(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_user_address(text, uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.delete_user_address(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_address(text, uuid) TO anon, authenticated;

-- ── Fix 3: vendor_verification insert (selfie) ───────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_vendor_verification(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_check_type text,
  p_doc_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_vendor_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = p_vendor_id AND v.phone = v_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.vendor_verification
  SET is_latest = false
  WHERE vendor_id = p_vendor_id
    AND check_type = p_check_type
    AND is_latest = true;

  INSERT INTO public.vendor_verification (
    vendor_id,
    check_type,
    status,
    checked_by,
    is_latest
  )
  VALUES (p_vendor_id, p_check_type, 'pending', 'system', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_vendor_verification(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_vendor_verification(uuid, text, text, text) TO anon, authenticated;

-- ── Fix 4: admin_actions insert ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_admin_phone text,
  p_action_type text,
  p_target_type text,
  p_target_id text,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_admin_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.is_admin_phone(v_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  INSERT INTO public.admin_actions (
    admin_phone,
    action_type,
    target_type,
    target_id,
    reason
  )
  VALUES (
    v_phone,
    p_action_type,
    p_target_type,
    p_target_id,
    NULLIF(trim(p_notes), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_admin_action(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, text, text) TO anon, authenticated;

-- ── Fix 5: admin dashboard stats ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_now timestamptz := now();
  v_start_of_today timestamptz;
  v_start_of_week timestamptz;
  v_stuck_cutoff timestamptz;
  v_total_orders integer;
  v_orders_today integer;
  v_orders_this_week integer;
  v_total_vendors integer;
  v_stuck_orders integer;
  v_active_vendors_today integer;
  v_new_vendors_this_week integer;
  v_unverified_vendors integer;
  v_risky_users integer;
  v_total_referrals integer;
  v_avg_vendor_rating numeric;
BEGIN
  v_phone := NULLIF(trim(p_admin_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.is_admin_phone(v_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  v_start_of_today := date_trunc('day', v_now AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_start_of_week := v_start_of_today - interval '7 days';
  v_stuck_cutoff := v_now - interval '48 hours';

  SELECT count(*)::integer INTO v_total_orders FROM public.requests;
  SELECT count(*)::integer INTO v_orders_today
  FROM public.requests WHERE created_at >= v_start_of_today;
  SELECT count(*)::integer INTO v_orders_this_week
  FROM public.requests WHERE created_at >= v_start_of_week;

  SELECT count(*)::integer INTO v_total_vendors FROM public.vendors;
  SELECT count(*)::integer INTO v_stuck_orders
  FROM public.requests
  WHERE status IN ('sent', 'accepted') AND created_at < v_stuck_cutoff;
  SELECT count(*)::integer INTO v_active_vendors_today
  FROM public.vendors WHERE last_updated >= v_start_of_today;
  SELECT count(*)::integer INTO v_new_vendors_this_week
  FROM public.vendors WHERE last_updated >= v_start_of_week;
  SELECT count(*)::integer INTO v_unverified_vendors
  FROM public.vendors WHERE is_manual_verified = false;
  SELECT count(*)::integer INTO v_risky_users
  FROM public.users WHERE trust_score < 25 AND is_banned = false;
  SELECT count(*)::integer INTO v_total_referrals FROM public.referrals;

  SELECT round(avg(avg_rating)::numeric, 1) INTO v_avg_vendor_rating
  FROM public.vendors
  WHERE avg_rating > 0 AND is_active = true;

  RETURN jsonb_build_object(
    'total_orders', COALESCE(v_total_orders, 0),
    'orders_today', COALESCE(v_orders_today, 0),
    'orders_this_week', COALESCE(v_orders_this_week, 0),
    'total_vendors', COALESCE(v_total_vendors, 0),
    'stuck_orders', COALESCE(v_stuck_orders, 0),
    'active_vendors_today', COALESCE(v_active_vendors_today, 0),
    'new_vendors_this_week', COALESCE(v_new_vendors_this_week, 0),
    'unverified_vendors', COALESCE(v_unverified_vendors, 0),
    'risky_users', COALESCE(v_risky_users, 0),
    'total_referrals', COALESCE(v_total_referrals, 0),
    'avg_vendor_rating', COALESCE(v_avg_vendor_rating, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats(text) TO anon, authenticated;
