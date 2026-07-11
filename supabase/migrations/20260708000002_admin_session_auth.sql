-- Admin authorization via Supabase Auth session (auth.uid()) + admin_users allowlist.
-- Replaces is_admin_phone(p_admin_phone) gating on admin RPCs with is_admin_session().
-- is_admin_phone() is retained for non-RPC callers (e.g. RLS policies).

-- ── 1. admin_users allowlist ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_users FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_users FROM anon, authenticated;

COMMENT ON TABLE public.admin_users IS
  'Supabase Auth user IDs allowed to invoke admin RPCs. Managed via service_role; no client policies.';

-- ── 2. Session gate ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.admin_users au
      WHERE au.user_id = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION public.is_admin_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_session() TO authenticated;

COMMENT ON FUNCTION public.is_admin_session() IS
  'True when the caller has a Supabase Auth session whose user_id is in admin_users.';

-- ── 3. Admin RPCs (session-gated; p_admin_phone kept only for API compat / audit) ─

CREATE OR REPLACE FUNCTION public.admin_ban_vendor(
  p_admin_phone text,
  p_vendor_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.vendors
  SET is_banned = true,
      ban_reason = NULLIF(trim(p_reason), '')
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unban_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.vendors
  SET is_banned = false,
      ban_reason = null
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_verify_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.vendors
  SET is_manual_verified = true
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unverify_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.vendors
  SET is_manual_verified = false,
      verification_status = CASE
        WHEN verification_status = 'green_pending' THEN 'business_verified'
        ELSE verification_status
      END
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_category(
  p_admin_phone text,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.categories
  SET is_active = true,
      pending_review = false,
      status = 'active'
  WHERE id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_category(
  p_admin_phone text,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.categories
  SET pending_review = false,
      is_active = false,
      status = 'rejected'
  WHERE id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_review(
  p_admin_phone text,
  p_review_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_review_count integer;
  v_avg_rating numeric;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT vendor_id INTO v_vendor_id
  FROM public.vendor_reviews
  WHERE id = p_review_id;
  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'review not found';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  DELETE FROM public.vendor_reviews WHERE id = p_review_id;

  SELECT COUNT(*)::integer, ROUND(AVG(rating)::numeric, 1)
  INTO v_review_count, v_avg_rating
  FROM public.vendor_reviews
  WHERE vendor_id = v_vendor_id;

  IF v_review_count = 0 THEN
    UPDATE public.vendors
    SET avg_rating = NULL,
        review_count = 0,
        low_rating_admin_notified = false
    WHERE id = v_vendor_id;
  ELSE
    UPDATE public.vendors
    SET avg_rating = v_avg_rating,
        review_count = v_review_count,
        low_rating_admin_notified = CASE
          WHEN v_avg_rating > 3.5 THEN false
          ELSE low_rating_admin_notified
        END
    WHERE id = v_vendor_id;
  END IF;

  RETURN v_vendor_id;
END;
$$;

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
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF NULLIF(trim(p_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid key';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  INSERT INTO public.app_config (key, value)
  VALUES (trim(p_key), coalesce(p_value, ''))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_ban_user(
  p_admin_phone text,
  p_user_phone text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.users
  SET is_banned = true,
      ban_reason = NULLIF(trim(p_reason), ''),
      trust_score = 0
  WHERE phone = trim(p_user_phone);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unban_user(
  p_admin_phone text,
  p_user_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.users
  SET is_banned = false,
      ban_reason = null,
      trust_score = 50
  WHERE phone = trim(p_user_phone);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_warn_user(
  p_admin_phone text,
  p_user_phone text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_warn_count integer;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.users
  SET warn_count = coalesce(warn_count, 0) + 1,
      last_warned_at = now()
  WHERE phone = trim(p_user_phone)
  RETURNING warn_count INTO v_next_warn_count;
  IF v_next_warn_count IS NULL THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  RETURN v_next_warn_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_vendor_check(
  p_admin_phone text,
  p_vendor_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  UPDATE public.vendor_verification
  SET is_latest = false
  WHERE vendor_id = p_vendor_id
    AND check_type = 'admin_check'
    AND is_latest = true;
  INSERT INTO public.vendor_verification (
    vendor_id,
    check_type,
    status,
    checked_by,
    is_latest
  )
  VALUES (p_vendor_id, 'admin_check', p_status, 'admin', true);
END;
$$;

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
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT au.lang
  INTO v_lang
  FROM public.app_users au
  WHERE au.phone = NULLIF(TRIM(p_user_phone), '');

  RETURN COALESCE(NULLIF(TRIM(v_lang), ''), 'en');
END;
$$;

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
  IF NOT public.is_admin_session() THEN
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

-- ── 4. Related admin-gated RPCs ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_start_of_today timestamptz;
  v_start_of_week timestamptz;
  v_stuck_cutoff timestamptz;
  v_total_orders integer;
  v_orders_today integer;
  v_orders_this_week integer;
  v_total_vendors integer;
  v_total_customers integer;
  v_stuck_orders integer;
  v_active_vendors_today integer;
  v_new_vendors_this_week integer;
  v_unverified_vendors integer;
  v_risky_users integer;
  v_total_referrals integer;
  v_avg_vendor_rating numeric;
BEGIN
  IF NOT public.is_admin_session() THEN
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
  SELECT count(*)::integer INTO v_total_customers FROM public.app_users;
  SELECT count(*)::integer INTO v_stuck_orders
  FROM public.requests
  WHERE status IN ('sent', 'accepted') AND created_at < v_stuck_cutoff;
  SELECT count(*)::integer INTO v_active_vendors_today
  FROM public.vendors
  WHERE is_active = true AND last_updated >= v_start_of_today;
  SELECT count(*)::integer INTO v_new_vendors_this_week
  FROM public.vendors WHERE created_at >= v_start_of_week;
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
    'total_customers', COALESCE(v_total_customers, 0),
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

CREATE OR REPLACE FUNCTION public.get_recommendations_for_admin(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_vendor_id uuid;
  v_super_admin boolean;
BEGIN
  v_super_admin := public.is_admin_session();
  v_vendor_id := NULL;

  IF v_super_admin THEN
    NULL;
  ELSE
    v_phone := public.auth_user_phone();
    IF v_phone IS NULL THEN
      RAISE EXCEPTION 'unauthorized';
    END IF;

    SELECT v.id
    INTO v_vendor_id
    FROM public.vendors v
    WHERE v.phone = v_phone
      AND v.is_active = true
    ORDER BY v.last_updated DESC NULLS LAST
    LIMIT 1;

    IF v_vendor_id IS NULL THEN
      RAISE EXCEPTION 'unauthorized';
    END IF;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_data ORDER BY created_at DESC)
      FROM (
        SELECT
          jsonb_build_object(
            'id', fp.id,
            'user_phone', fp.user_phone,
            'content', fp.content,
            'recommended_vendor_id', fp.recommended_vendor_id,
            'recommended_vendor_name', fp.recommended_vendor_name,
            'recommended_vendor_phone', fp.recommended_vendor_phone,
            'reach_radius_km', fp.reach_radius_km,
            'created_at', fp.created_at,
            'expires_at', fp.expires_at
          ) AS row_data,
          fp.created_at
        FROM public.feed_posts fp
        WHERE fp.type = 'recommendation'
          AND fp.is_hidden = false
          AND (
            v_super_admin
            OR fp.recommended_vendor_id = v_vendor_id
            OR (
              fp.recommended_vendor_phone IS NOT NULL
              AND trim(fp.recommended_vendor_phone) = v_phone
            )
          )
        ORDER BY fp.created_at DESC
        LIMIT 100
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

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
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  v_phone := NULLIF(trim(p_admin_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
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

-- ── 5. Grants: authenticated only (revoke anon) ────────────────────────────────

REVOKE ALL ON FUNCTION public.admin_ban_vendor(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_ban_vendor(text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_ban_vendor(text, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unban_vendor(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unban_vendor(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_unban_vendor(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_verify_vendor(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_verify_vendor(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_verify_vendor(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unverify_vendor(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unverify_vendor(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_unverify_vendor(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_approve_category(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_category(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_category(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reject_category(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reject_category(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_category(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_delete_review(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_review(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_review(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_app_config(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_app_config(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_update_app_config(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_ban_user(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_ban_user(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_ban_user(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unban_user(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unban_user(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_unban_user(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_warn_user(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_warn_user(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_warn_user(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_set_vendor_check(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_vendor_check(text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_vendor_check(text, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_user_lang(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_user_lang(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_lang(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_apply_vendor_waiveoff(text, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_apply_vendor_waiveoff(text, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_apply_vendor_waiveoff(text, uuid, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats(text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_recommendations_for_admin(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_recommendations_for_admin(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_recommendations_for_admin(text) TO authenticated;

REVOKE ALL ON FUNCTION public.log_admin_action(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_admin_action(text, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, text, text) TO authenticated;
