-- Admin Dashboard & Moderation hardening:
-- 1) Recommendation lead queue: feed_posts.admin_contacted_at / admin_dismissed_at
--    (contacted marker + reversible soft-removal), three new admin RPCs
--    (mark-contacted / dismiss / restore), and get_recommendations_for_admin
--    gains p_include_dismissed. The admin default view now hides dismissed
--    leads plus auto-resolved leads (named phone has since onboarded as a
--    vendor). The vendor-own-leads branch (auth_user_phone()) is untouched.
-- 2) admin_update_app_config: server-side key whitelist (mirror of
--    ADMIN_CONFIG_WHITELIST in src/pages/Settings.tsx) — key_not_allowed.
-- 3) admin_apply_vendor_waiveoff: sets app.via_admin_rpc, and
--    waiveoff_percent / waiveoff_months_remaining join the
--    prevent_direct_admin_column_writes guarded-column list.
-- 4) Grant consistency: anon EXECUTE revoked from session-gated admin RPCs
--    that had been left with anon grants.
-- 5) log_admin_action: label derived from the admin session (auth.users)
--    first; caller-supplied p_admin_phone is only a fallback and the audit
--    row is never silently skipped (final fallback: auth.uid()::text).

-- ── 1a. Lead queue columns ────────────────────────────────────────────────────

ALTER TABLE public.feed_posts
  ADD COLUMN IF NOT EXISTS admin_contacted_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS admin_dismissed_at timestamptz DEFAULT NULL;

COMMENT ON COLUMN public.feed_posts.admin_contacted_at IS
  'Admin lead queue: when the admin marked this recommendation lead as contacted (non-destructive marker).';
COMMENT ON COLUMN public.feed_posts.admin_dismissed_at IS
  'Admin lead queue: when the admin soft-removed this recommendation from the default review list (reversible).';

-- ── 5. log_admin_action: session-derived label, never skip ───────────────────

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
  v_label text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Session identity first (guaranteed once is_admin_session() passed),
  -- caller-supplied label as compat fallback, auth.uid() as last resort —
  -- the audit row is never skipped for a session admin.
  SELECT COALESCE(
    NULLIF(trim(u.email), ''),
    NULLIF(trim(u.phone), '')
  )
  INTO v_label
  FROM auth.users u
  WHERE u.id = auth.uid();

  v_label := COALESCE(
    NULLIF(trim(v_label), ''),
    NULLIF(trim(p_admin_phone), ''),
    auth.uid()::text
  );

  INSERT INTO public.admin_actions (
    admin_phone,
    action_type,
    target_type,
    target_id,
    reason
  )
  VALUES (
    v_label,
    p_action_type,
    p_target_type,
    p_target_id,
    NULLIF(trim(p_notes), '')
  );
END;
$$;

COMMENT ON FUNCTION public.log_admin_action(text, text, text, text, text) IS
  'Inserts an admin_actions audit row. admin_phone comes from auth.users email/phone for auth.uid(); p_admin_phone then auth.uid()::text are fallbacks — never skipped.';

-- ── 1b. Recommendation lead queue RPCs ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_mark_recommendation_contacted(
  p_admin_phone text,
  p_post_id uuid,
  p_contacted boolean
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
  UPDATE public.feed_posts
  SET admin_contacted_at = CASE WHEN COALESCE(p_contacted, false) THEN now() ELSE NULL END
  WHERE id = p_post_id
    AND type = 'recommendation';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post not found';
  END IF;
  PERFORM public.log_admin_action(
    p_admin_phone,
    'mark_recommendation_contacted',
    'feed_post',
    p_post_id::text,
    CASE WHEN COALESCE(p_contacted, false) THEN 'contacted' ELSE 'contacted_cleared' END
  );
END;
$$;

COMMENT ON FUNCTION public.admin_mark_recommendation_contacted(text, uuid, boolean) IS
  'Toggle the contacted marker on a recommendation lead (does not hide the row).';

CREATE OR REPLACE FUNCTION public.admin_dismiss_recommendation(
  p_admin_phone text,
  p_post_id uuid
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
  UPDATE public.feed_posts
  SET admin_dismissed_at = now()
  WHERE id = p_post_id
    AND type = 'recommendation';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post not found';
  END IF;
  PERFORM public.log_admin_action(
    p_admin_phone,
    'dismiss_recommendation',
    'feed_post',
    p_post_id::text,
    NULL
  );
END;
$$;

COMMENT ON FUNCTION public.admin_dismiss_recommendation(text, uuid) IS
  'Soft-remove a recommendation lead from the admin default view (data retained, reversible).';

CREATE OR REPLACE FUNCTION public.admin_restore_recommendation(
  p_admin_phone text,
  p_post_id uuid
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
  UPDATE public.feed_posts
  SET admin_dismissed_at = NULL
  WHERE id = p_post_id
    AND type = 'recommendation';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post not found';
  END IF;
  PERFORM public.log_admin_action(
    p_admin_phone,
    'restore_recommendation',
    'feed_post',
    p_post_id::text,
    NULL
  );
END;
$$;

COMMENT ON FUNCTION public.admin_restore_recommendation(text, uuid) IS
  'Undo admin_dismiss_recommendation; the lead returns to the default review list.';

-- ── 1c. get_recommendations_for_admin: p_include_dismissed + auto-resolve ─────

-- Parameter list changes (text) -> (text, boolean DEFAULT false): explicit DROP
-- required, CREATE OR REPLACE would create an ambiguous overload.
DROP FUNCTION IF EXISTS public.get_recommendations_for_admin(text);

CREATE FUNCTION public.get_recommendations_for_admin(
  p_admin_phone text,
  p_include_dismissed boolean DEFAULT false
)
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
    -- Vendor-own-leads branch: unchanged (a vendor sees posts naming them).
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
            'expires_at', fp.expires_at,
            'admin_contacted_at', fp.admin_contacted_at,
            'admin_dismissed_at', fp.admin_dismissed_at,
            -- Lead auto-resolved: the named phone has since onboarded.
            'vendor_onboarded', (
              fp.recommended_vendor_id IS NULL
              AND fp.recommended_vendor_phone IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.vendors ov
                WHERE ov.phone = trim(fp.recommended_vendor_phone)
              )
            )
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
          -- Admin default view only: hide dismissed + auto-resolved leads.
          -- Vendor-own-leads branch is unaffected (NOT v_super_admin short-circuits).
          AND (
            NOT v_super_admin
            OR p_include_dismissed
            OR (
              fp.admin_dismissed_at IS NULL
              AND NOT (
                fp.recommended_vendor_id IS NULL
                AND fp.recommended_vendor_phone IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM public.vendors ov
                  WHERE ov.phone = trim(fp.recommended_vendor_phone)
                )
              )
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

COMMENT ON FUNCTION public.get_recommendations_for_admin(text, boolean) IS
  'Admin: recommendation lead queue (default view hides dismissed/auto-resolved). Vendors: own leads only.';

-- ── 2. admin_update_app_config: server-side whitelist ─────────────────────────

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
    'dev_menu_pin',
    'feed_notification_radius_km',
    'app_base_url'
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

-- ── 3a. admin_apply_vendor_waiveoff: via_admin_rpc parity ─────────────────────

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

  -- waiveoff columns are guarded by prevent_direct_admin_column_writes.
  PERFORM set_config('app.via_admin_rpc', 'true', true);

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

-- ── 3b. Guard trigger: waiveoff columns join the protected list ───────────────

CREATE OR REPLACE FUNCTION public.prevent_direct_admin_column_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public._admin_guard_bypassed() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'vendors' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_banned IS DISTINCT FROM OLD.is_banned
       OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason
       OR NEW.is_manual_verified IS DISTINCT FROM OLD.is_manual_verified
       OR NEW.waiveoff_percent IS DISTINCT FROM OLD.waiveoff_percent
       OR NEW.waiveoff_months_remaining IS DISTINCT FROM OLD.waiveoff_months_remaining THEN
      RAISE EXCEPTION 'direct admin column write blocked on vendors';
    END IF;

  ELSIF TG_TABLE_NAME = 'users' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_banned IS DISTINCT FROM OLD.is_banned
       OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason
       OR NEW.warn_count IS DISTINCT FROM OLD.warn_count
       OR NEW.trust_score IS DISTINCT FROM OLD.trust_score THEN
      RAISE EXCEPTION 'direct admin column write blocked on users';
    END IF;

  ELSIF TG_TABLE_NAME = 'categories' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.pending_review IS DISTINCT FROM OLD.pending_review
       OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'direct admin column write blocked on categories';
    END IF;

  ELSIF TG_TABLE_NAME = 'app_config' AND TG_OP = 'UPDATE' THEN
    IF NEW.value IS DISTINCT FROM OLD.value THEN
      RAISE EXCEPTION 'direct app_config value write blocked';
    END IF;

  ELSIF TG_TABLE_NAME = 'app_config' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'direct app_config insert blocked';

  ELSIF TG_TABLE_NAME = 'vendor_verification' AND TG_OP = 'INSERT' THEN
    IF NEW.check_type = 'admin_check' AND NEW.checked_by = 'admin' THEN
      RAISE EXCEPTION 'direct admin_check insert blocked on vendor_verification';
    END IF;

  ELSIF TG_TABLE_NAME = 'vendor_verification' AND TG_OP = 'UPDATE' THEN
    IF OLD.check_type = 'admin_check' OR NEW.check_type = 'admin_check' THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR NEW.is_latest IS DISTINCT FROM OLD.is_latest
         OR NEW.checked_by IS DISTINCT FROM OLD.checked_by THEN
        RAISE EXCEPTION 'direct admin_check update blocked on vendor_verification';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'vendor_reviews' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct vendor_reviews delete blocked';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── 4. Grants ─────────────────────────────────────────────────────────────────

-- New lead-queue RPCs: authenticated admin sessions only.
REVOKE ALL ON FUNCTION public.admin_mark_recommendation_contacted(text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_mark_recommendation_contacted(text, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_recommendation_contacted(text, uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_dismiss_recommendation(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_dismiss_recommendation(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_dismiss_recommendation(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_restore_recommendation(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_restore_recommendation(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_restore_recommendation(text, uuid) TO authenticated;

-- Recreated with a new signature: re-establish authenticated-only access.
REVOKE ALL ON FUNCTION public.get_recommendations_for_admin(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_recommendations_for_admin(text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_recommendations_for_admin(text, boolean) TO authenticated;

-- Session-gated admin RPCs that still carried anon EXECUTE grants — align with
-- the authenticated-only majority pattern (20260708000002).
REVOKE ALL ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_admin_fcm_failure_stats(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_fcm_failure_stats(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_admin_radar_health_stats(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_radar_health_stats(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_admin_restore_health_stats(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_restore_health_stats(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_admin_green_pending_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_green_pending_stats() TO authenticated, service_role;
