-- FirstOpen / session restore hardening:
-- 1) get_vendor_restore_status (SECURITY DEFINER, phone rate-limited, status-only payload)
-- 2) rate-limit lookup_user_by_phone (phone-based)
-- 3) server-side ban gates for sensitive vendor mutations
-- 4) firstopen_restore_log + admin restore health stats

-- ── Ban assertion helper ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._assert_vendor_not_banned(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_banned boolean;
BEGIN
  IF p_vendor_id IS NULL OR p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT COALESCE(v.is_banned, false)
  INTO v_banned
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone)
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF v_banned THEN
    RAISE EXCEPTION 'vendor_banned';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._assert_vendor_not_banned(uuid, text) IS
  'Raises vendor_banned when the owned vendor row is banned.';

REVOKE ALL ON FUNCTION public._assert_vendor_not_banned(uuid, text) FROM PUBLIC;

-- Force banned vendors offline; block go-live attempts at the table level.
CREATE OR REPLACE FUNCTION public.vendors_enforce_banned_offline()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_banned, false) THEN
    NEW.is_active := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendors_enforce_banned_offline_trg ON public.vendors;
CREATE TRIGGER vendors_enforce_banned_offline_trg
  BEFORE INSERT OR UPDATE OF is_banned, is_active ON public.vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.vendors_enforce_banned_offline();

-- vendor_accept_order: reject banned vendors
CREATE OR REPLACE FUNCTION public.vendor_accept_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_from_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET status = 'accepted'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND r.status = p_from_status
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text) TO anon, authenticated;

-- vendor_update_own: block is_active=true when banned (preserve live body via inject)
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p
  WHERE p.proname = 'vendor_update_own'
    AND p.pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'vendor_update_own missing';
  END IF;

  IF position('_assert_vendor_not_banned' IN def) > 0 THEN
    RETURN;
  END IF;

  def := replace(
    def,
    E'BEGIN\n  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN',
    E'BEGIN\n  IF p_patch ? ''is_active'' AND (p_patch->>''is_active'')::boolean IS TRUE THEN\n    PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);\n  END IF;\n\n  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN'
  );

  IF position('_assert_vendor_not_banned' IN def) = 0 THEN
    RAISE EXCEPTION 'failed to inject ban gate into vendor_update_own';
  END IF;

  EXECUTE def;
END;
$$;

-- vendor_edit_bill: reject banned vendors (inject assert after BEGIN)
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p
  WHERE p.proname = 'vendor_edit_bill'
    AND p.pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'vendor_edit_bill missing';
  END IF;

  IF position('_assert_vendor_not_banned' IN def) > 0 THEN
    RETURN;
  END IF;

  def := replace(
    def,
    E'BEGIN\n  IF NOT EXISTS (',
    E'BEGIN\n  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);\n\n  IF NOT EXISTS ('
  );

  IF position('_assert_vendor_not_banned' IN def) = 0 THEN
    RAISE EXCEPTION 'failed to inject ban gate into vendor_edit_bill';
  END IF;

  EXECUTE def;
END;
$$;

-- get_vendor_own: keep returning full row including is_banned so UI can show banned state.
-- (No filter change — dashboard read of banned own account is intentional.)

-- ── lookup_user_by_phone rate limit ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lookup_user_by_phone(p_phone text)
RETURNS TABLE(
  total_orders integer,
  completed_orders integer,
  trust_score double precision,
  warn_count integer,
  is_banned boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text := trim(COALESCE(p_phone, ''));
BEGIN
  IF v_phone = '' THEN
    RETURN;
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'lookup_user_by_phone',
    'phone',
    v_phone,
    10,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  RETURN QUERY
  SELECT u.total_orders, u.completed_orders, u.trust_score, u.warn_count, u.is_banned
  FROM public.users u
  WHERE u.phone = v_phone
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_user_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_user_by_phone(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.lookup_user_by_phone(text) IS
  'Public user trust lookup by phone; rate-limited 10/min per phone.';

-- ── get_vendor_restore_status ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_restore_status(p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text := trim(COALESCE(p_phone, ''));
  v_row public.vendors%ROWTYPE;
  v_allowed boolean := false;
  v_deny text := 'not_found';
BEGIN
  IF v_phone = '' THEN
    RETURN jsonb_build_object(
      'found', false,
      'vendor_id', null,
      'is_banned', false,
      'is_active', false,
      'discoverable', false,
      'profile_status', null,
      'deletion_requested_at', null,
      'restore_allowed', false,
      'deny_reason', 'not_found'
    );
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_restore_status',
    'phone',
    v_phone,
    10,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  -- Owner self-check: bypass public discoverability RLS by reading as DEFINER.
  SELECT * INTO v_row
  FROM public.vendors v
  WHERE v.phone = v_phone
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', false,
      'vendor_id', null,
      'is_banned', false,
      'is_active', false,
      'discoverable', false,
      'profile_status', null,
      'deletion_requested_at', null,
      'restore_allowed', false,
      'deny_reason', 'not_found'
    );
  END IF;

  IF COALESCE(v_row.is_banned, false) THEN
    v_allowed := false;
    v_deny := 'banned';
  ELSIF v_row.deletion_requested_at IS NOT NULL THEN
    v_allowed := false;
    v_deny := 'deleted';
  ELSE
    -- Hidden / incomplete / offline are visibility or operating toggles — restore OK.
    v_allowed := true;
    v_deny := null;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'vendor_id', v_row.id,
    'is_banned', COALESCE(v_row.is_banned, false),
    'is_active', COALESCE(v_row.is_active, false),
    'discoverable', COALESCE(v_row.discoverable, false),
    'profile_status', v_row.profile_status,
    'deletion_requested_at', v_row.deletion_requested_at,
    'restore_allowed', v_allowed,
    'deny_reason', v_deny
  );
END;
$$;

COMMENT ON FUNCTION public.get_vendor_restore_status(text) IS
  'FirstOpen restore lookup: status fields only; rate-limited; bypasses discoverability RLS for owner self-check.';

REVOKE ALL ON FUNCTION public.get_vendor_restore_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_restore_status(text) TO anon, authenticated, service_role;

-- ── Restore telemetry ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.firstopen_restore_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome text NOT NULL,
  device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firstopen_restore_log_outcome_chk CHECK (
    outcome IN (
      'success_customer',
      'success_vendor',
      'success_vendor_offline',
      'success_vendor_hidden',
      'success_vendor_incomplete',
      'success_dual',
      'denied_banned',
      'denied_deleted',
      'not_found',
      'rate_limited',
      'error'
    )
  )
);

CREATE INDEX IF NOT EXISTS firstopen_restore_log_created_at_idx
  ON public.firstopen_restore_log (created_at DESC);

CREATE INDEX IF NOT EXISTS firstopen_restore_log_outcome_idx
  ON public.firstopen_restore_log (outcome, created_at DESC);

ALTER TABLE public.firstopen_restore_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firstopen_restore_log_service ON public.firstopen_restore_log;
CREATE POLICY firstopen_restore_log_service ON public.firstopen_restore_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.log_firstopen_restore(
  p_outcome text,
  p_device_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_outcome IS NULL OR trim(p_outcome) = '' THEN
    RETURN;
  END IF;

  IF p_outcome NOT IN (
    'success_customer',
    'success_vendor',
    'success_vendor_offline',
    'success_vendor_hidden',
    'success_vendor_incomplete',
    'success_dual',
    'denied_banned',
    'denied_deleted',
    'not_found',
    'rate_limited',
    'error'
  ) THEN
    RETURN;
  END IF;

  IF p_device_id IS NOT NULL AND trim(p_device_id) <> '' THEN
    IF (
      SELECT count(*)::integer
      FROM public.firstopen_restore_log l
      WHERE l.device_id = trim(p_device_id)
        AND l.created_at > now() - interval '1 minute'
    ) >= 30 THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.firstopen_restore_log (outcome, device_id)
  VALUES (
    trim(p_outcome),
    CASE WHEN p_device_id IS NULL OR trim(p_device_id) = '' THEN NULL ELSE trim(p_device_id) END
  );
END;
$$;

COMMENT ON FUNCTION public.log_firstopen_restore(text, text) IS
  'Best-effort FirstOpen restore telemetry (rate-limited per device).';

CREATE OR REPLACE FUNCTION public.get_admin_restore_health_stats(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hours integer := greatest(coalesce(p_hours, 24), 1);
  v_attempts bigint;
  v_successes bigint;
  v_denied_banned bigint;
  v_denied_deleted bigint;
  v_not_found bigint;
  v_offline_restorable bigint;
  v_hidden_restorable bigint;
BEGIN
  IF NOT public.is_admin_session()
     AND coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(*) INTO v_attempts
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval;

  SELECT count(*) INTO v_successes
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.outcome IN (
      'success_customer',
      'success_vendor',
      'success_vendor_offline',
      'success_vendor_hidden',
      'success_vendor_incomplete',
      'success_dual'
    );

  SELECT count(*) INTO v_denied_banned
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.outcome = 'denied_banned';

  SELECT count(*) INTO v_denied_deleted
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.outcome = 'denied_deleted';

  SELECT count(*) INTO v_not_found
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.outcome = 'not_found';

  SELECT count(*) INTO v_offline_restorable
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.outcome = 'success_vendor_offline';

  SELECT count(*) INTO v_hidden_restorable
  FROM public.firstopen_restore_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.outcome = 'success_vendor_hidden';

  RETURN jsonb_build_object(
    'attempts', coalesce(v_attempts, 0),
    'successes', coalesce(v_successes, 0),
    'denied_banned', coalesce(v_denied_banned, 0),
    'denied_deleted', coalesce(v_denied_deleted, 0),
    'not_found', coalesce(v_not_found, 0),
    'offline_now_restorable', coalesce(v_offline_restorable, 0),
    'hidden_now_restorable', coalesce(v_hidden_restorable, 0),
    'success_rate_pct',
      CASE
        WHEN coalesce(v_attempts, 0) = 0 THEN 0
        ELSE round((v_successes::numeric / v_attempts::numeric) * 100, 1)
      END
  );
END;
$$;

COMMENT ON FUNCTION public.get_admin_restore_health_stats(integer) IS
  'Admin FirstOpen restore health over a rolling window.';

REVOKE ALL ON FUNCTION public.log_firstopen_restore(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_firstopen_restore(text, text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_admin_restore_health_stats(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_restore_health_stats(integer) TO anon, authenticated, service_role;
