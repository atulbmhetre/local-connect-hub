-- Radar hardening: tighten vendors public read, vendor/customer read RPCs, radar health log.

-- ── 1. Vendors RLS: discovery-only public read ───────────────────────────────

DROP POLICY IF EXISTS vendors_public_read ON public.vendors;
DROP POLICY IF EXISTS vendors_public_discoverable_read ON public.vendors;

CREATE POLICY vendors_public_discoverable_read ON public.vendors
  FOR SELECT
  TO anon, authenticated
  USING (
    discoverable = true
    AND is_banned = false
    AND profile_status = 'complete'
  );

COMMENT ON POLICY vendors_public_discoverable_read ON public.vendors IS
  'Customer discovery (Radar, feed vendor search): only discoverable, non-banned, complete profiles.';

DROP POLICY IF EXISTS vendors_admin_read ON public.vendors;

CREATE POLICY vendors_admin_read ON public.vendors
  FOR SELECT
  TO anon, authenticated
  USING (public.is_admin_session());

COMMENT ON POLICY vendors_admin_read ON public.vendors IS
  'Admin Settings vendor list may read all vendor rows when admin session is active.';

-- vendors_owner (FOR ALL, phone = auth_user_phone()) unchanged — Supabase-auth vendor self-service.

-- ── 2. OTP-off vendor self-read + customer context reads ─────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_own(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS public.vendors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vendors;
BEGIN
  IF p_vendor_id IS NULL OR p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT * INTO v_row
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone)
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_own(uuid, text) IS
  'Vendor reads own row by id+phone (OTP-off localStorage identity). Bypasses discoverable RLS.';

CREATE OR REPLACE FUNCTION public.get_vendor_by_phone_login(
  p_phone text
)
RETURNS public.vendors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vendors;
  v_digits text;
BEGIN
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) = 12 AND v_digits LIKE '91%' THEN
    v_digits := right(v_digits, 10);
  ELSIF length(v_digits) = 11 AND v_digits LIKE '1%' THEN
    v_digits := right(v_digits, 10);
  END IF;

  IF v_digits IS NULL OR length(v_digits) <> 10 THEN
    RAISE EXCEPTION 'phone_invalid';
  END IF;

  SELECT * INTO v_row
  FROM public.vendors v
  WHERE v.phone = v_digits
    AND v.is_banned = false
    AND v.deletion_requested_at IS NULL
    AND v.phone NOT LIKE 'deleted_%'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_by_phone_login(text) IS
  'Vendor login lookup by phone; returns full row including non-discoverable/banned-adjacent states.';

CREATE OR REPLACE FUNCTION public.get_vendors_visible_to_customer(
  p_vendor_ids uuid[],
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS SETOF public.vendors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_ids IS NULL OR cardinality(p_vendor_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT v.*
  FROM public.vendors v
  WHERE v.id = ANY(p_vendor_ids)
    AND (
      (
        v.discoverable = true
        AND v.is_banned = false
        AND v.profile_status = 'complete'
      )
      OR EXISTS (
        SELECT 1
        FROM public.requests r
        WHERE r.vendor_id = v.id
          AND (
            (p_user_phone IS NOT NULL AND trim(p_user_phone) <> '' AND r.user_phone = trim(p_user_phone))
            OR (p_device_id IS NOT NULL AND trim(p_device_id) <> '' AND r.device_id = trim(p_device_id))
          )
      )
    );
END;
$$;

COMMENT ON FUNCTION public.get_vendors_visible_to_customer(uuid[], text, text) IS
  'Returns vendor rows discoverable on Radar OR tied to this customer via prior requests (tracking/orders).';

REVOKE ALL ON FUNCTION public.get_vendor_own(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_own(uuid, text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_vendor_by_phone_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_by_phone_login(text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_vendors_visible_to_customer(uuid[], text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendors_visible_to_customer(uuid[], text, text) TO anon, authenticated, service_role;

-- ── 3. Radar search health log + admin stats ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.radar_search_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text,
  result_count integer NOT NULL,
  categories_loaded boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS radar_search_log_created_at_idx
  ON public.radar_search_log (created_at DESC);

ALTER TABLE public.radar_search_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS radar_search_log_service ON public.radar_search_log;
CREATE POLICY radar_search_log_service ON public.radar_search_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.log_radar_search(
  p_device_id text,
  p_result_count integer,
  p_categories_loaded boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RETURN;
  END IF;

  IF (
    SELECT count(*)::integer
    FROM public.radar_search_log l
    WHERE l.device_id = trim(p_device_id)
      AND l.created_at > now() - interval '1 minute'
  ) >= 30 THEN
    RETURN;
  END IF;

  INSERT INTO public.radar_search_log (device_id, result_count, categories_loaded)
  VALUES (trim(p_device_id), coalesce(p_result_count, 0), coalesce(p_categories_loaded, true));
END;
$$;

COMMENT ON FUNCTION public.log_radar_search(text, integer, boolean) IS
  'Best-effort radar search telemetry (rate-limited per device).';

CREATE OR REPLACE FUNCTION public.get_admin_radar_health_stats(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hours integer := greatest(coalesce(p_hours, 24), 1);
  v_total bigint;
  v_zero bigint;
  v_active_categories bigint;
BEGIN
  IF NOT public.is_admin_session()
     AND coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.radar_search_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval;

  SELECT count(*) INTO v_zero
  FROM public.radar_search_log l
  WHERE l.created_at >= now() - (v_hours || ' hours')::interval
    AND l.result_count = 0;

  SELECT count(*) INTO v_active_categories
  FROM public.categories c
  WHERE c.is_active = true;

  RETURN jsonb_build_object(
    'total_searches', coalesce(v_total, 0),
    'zero_result_searches', coalesce(v_zero, 0),
    'zero_result_rate_pct',
      CASE
        WHEN coalesce(v_total, 0) = 0 THEN 0
        ELSE round((v_zero::numeric / v_total::numeric) * 100, 1)
      END,
    'active_categories_count', coalesce(v_active_categories, 0),
    'categories_ok', coalesce(v_active_categories, 0) > 0
  );
END;
$$;

COMMENT ON FUNCTION public.get_admin_radar_health_stats(integer) IS
  'Admin radar health: zero-result rate (logged searches) + active category count.';

REVOKE ALL ON FUNCTION public.log_radar_search(text, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_radar_search(text, integer, boolean) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_admin_radar_health_stats(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_radar_health_stats(integer) TO anon, authenticated, service_role;
