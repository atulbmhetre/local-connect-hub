-- Customer-side read hardening, final discovery-scan cleanup (OTP-off identity model).
--
-- Same class of bug fixed tonight in saved_vendors (20260718000001), vendor restore
-- (20260718010001), MyOrders (20260718020001), and the vendor read paths
-- (20260718030001 / 20260718040001): direct table reads under RLS policies that
-- require auth_user_phone(), which is always NULL for OTP-off callers. This
-- migration closes the remaining flagged customer-side sites:
--
--   1) get_my_help_banner_orders      — Index.tsx accepted-help banner (requests)
--   2) get_my_active_order_count      — Index.tsx active-order badge (requests)
--   3) get_my_active_request_vendor_ids — Index neighbour-sheet checks,
--        RadarSearch active-order markers, RadarVendorCard per-card active state (requests)
--   4) get_my_fulfilled_request_ids   — RadarSearch/RadarVendorCard fulfilled/rating
--        eligibility (requests)
--   5) get_saved_vendors_count        — RadarVendorCard MAX_SAVED_NEIGHBOURS gate
--        (saved_vendors; list reads reuse the existing get_saved_vendors RPC)
--   6) get_my_feed_flags              — LocalFeed "already flagged by me" state (feed_flags)
--   7) get_my_addresses               — useUserAddresses (user_addresses), plus DROP of
--        the PROD-only legacy SELECT policy "Users can read own addresses" whose
--        `user_phone IS NOT NULL` arm made every phone-linked address world-readable
--   8) should_notify_vendor_order_edit — MyOrders edit-order push dedup. Fixes the
--        wrong-owner logic error: the client read user_notifications WHERE
--        user_phone = <vendor phone>, i.e. someone else's rows (blocked by RLS even
--        with a session, so dedup silently never worked). The check now runs
--        server-side, keyed off the request row the caller actually owns.
--
-- fetchUserTrust (users) is fixed client-side by reusing the existing rate-limited
-- lookup_user_by_phone RPC — no new RPC needed.
-- All RPCs are SECURITY DEFINER with caller-supplied phone/device identity and
-- check_and_log_rate_limit. RLS stays restrictive — no USING(true) anywhere.

-- ── helper: pick rate-limit identity (phone when present, else device) ────────
-- (inline in each function, mirroring 20260718020001's pattern)

-- ── 1. get_my_help_banner_orders ──────────────────────────────────────────────
-- Mirrors Index.loadHelpOrderBanner: own accepted orders updated in the last 48h,
-- newest first, with the vendor fields the banner needs. The help-mode filter
-- stays client-side (faithful lift-and-shift).

CREATE OR REPLACE FUNCTION public.get_my_help_banner_orders(
  p_user_phone text
)
RETURNS TABLE (
  id uuid,
  status text,
  updated_at timestamptz,
  vendor_shop_name text,
  vendor_service_mode text,
  vendor_last_updated timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_my_help_banner_orders', 'phone', btrim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.id, r.status, r.updated_at,
         v.shop_name, v.service_mode, v.last_updated
  FROM public.requests r
  LEFT JOIN public.vendors v ON v.id = r.vendor_id
  WHERE r.user_phone = btrim(p_user_phone)
    AND r.status = 'accepted'
    AND r.updated_at > now() - interval '48 hours'
  ORDER BY r.updated_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_help_banner_orders(text) IS
  'Own accepted orders updated in the last 48h with vendor fields, for the Home help-order banner. OTP-off read path; RLS stays restrictive.';

REVOKE ALL ON FUNCTION public.get_my_help_banner_orders(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_help_banner_orders(text) TO anon, authenticated, service_role;

-- ── 2. get_my_active_order_count ──────────────────────────────────────────────
-- Mirrors Index.loadActiveOrderCount: buildRequestsActiveWindowOrFilter("user") —
-- sent/accepted/cancelled/expired within 48h, seen within 24h, fulfilled any age,
-- omits done. Phone-scoped when phone present, else device (same as the client).

CREATE OR REPLACE FUNCTION public.get_my_active_order_count(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_count integer;
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

  IF NOT public.check_and_log_rate_limit('get_my_active_order_count', v_rl_type, v_rl_id, 60, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.requests r
  WHERE (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN r.user_phone = btrim(p_user_phone)
        ELSE r.device_id = btrim(p_device_id)
      END
    )
    AND (
      (r.status = 'sent'      AND r.created_at >= now() - interval '48 hours') OR
      (r.status = 'seen'      AND r.created_at >= now() - interval '24 hours') OR
      (r.status = 'accepted'  AND r.created_at >= now() - interval '48 hours') OR
      (r.status = 'cancelled' AND r.created_at >= now() - interval '48 hours') OR
      (r.status = 'expired'   AND r.created_at >= now() - interval '48 hours') OR
      r.status = 'fulfilled'
    );

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.get_my_active_order_count(text, text) IS
  'Count of own active-window orders (user role window: sent/accepted/cancelled/expired 48h, seen 24h, fulfilled any age). OTP-off read path for the Home badge.';

REVOKE ALL ON FUNCTION public.get_my_active_order_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_active_order_count(text, text) TO anon, authenticated, service_role;

-- ── 3. get_my_active_request_vendor_ids ───────────────────────────────────────
-- Mirrors the sent/seen "active order with this vendor" probes in Index's
-- neighbour sheet (device-scoped) and RadarSearch/RadarVendorCard (phone OR
-- device when phone present). Caller controls scoping by what it passes.
-- Higher rate ceiling: RadarVendorCard refreshes per visible card at once.

CREATE OR REPLACE FUNCTION public.get_my_active_request_vendor_ids(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_vendor_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (vendor_id uuid)
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

  IF p_vendor_ids IS NULL OR array_length(p_vendor_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_active_request_vendor_ids', v_rl_type, v_rl_id, 120, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.vendor_id
  FROM public.requests r
  WHERE r.vendor_id = ANY (p_vendor_ids)
    AND r.status IN ('sent', 'seen')
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN (r.user_phone = btrim(p_user_phone) OR r.device_id = btrim(p_device_id))
        ELSE r.device_id = btrim(p_device_id)
      END
    );
END;
$$;

COMMENT ON FUNCTION public.get_my_active_request_vendor_ids(text, text, uuid[]) IS
  'vendor_ids among p_vendor_ids where the caller has a sent/seen request (phone OR device when phone present, else device). OTP-off read path for radar/neighbour active-order markers.';

REVOKE ALL ON FUNCTION public.get_my_active_request_vendor_ids(text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_active_request_vendor_ids(text, text, uuid[]) TO anon, authenticated, service_role;

-- ── 4. get_my_fulfilled_request_ids ───────────────────────────────────────────
-- Mirrors the status='fulfilled' probes in RadarSearch (rating eligibility marker,
-- first request id per vendor) and RadarVendorCard.

CREATE OR REPLACE FUNCTION public.get_my_fulfilled_request_ids(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_vendor_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (id uuid, vendor_id uuid)
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

  IF p_vendor_ids IS NULL OR array_length(p_vendor_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_fulfilled_request_ids', v_rl_type, v_rl_id, 120, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.id, r.vendor_id
  FROM public.requests r
  WHERE r.vendor_id = ANY (p_vendor_ids)
    AND r.status = 'fulfilled'
    AND (
      CASE
        WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
          THEN (r.user_phone = btrim(p_user_phone) OR r.device_id = btrim(p_device_id))
        ELSE r.device_id = btrim(p_device_id)
      END
    );
END;
$$;

COMMENT ON FUNCTION public.get_my_fulfilled_request_ids(text, text, uuid[]) IS
  'Own fulfilled request ids per vendor among p_vendor_ids. OTP-off read path for radar fulfilled/rating-eligibility markers.';

REVOKE ALL ON FUNCTION public.get_my_fulfilled_request_ids(text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_fulfilled_request_ids(text, text, uuid[]) TO anon, authenticated, service_role;

-- ── 5. get_saved_vendors_count ────────────────────────────────────────────────
-- Mirrors RadarVendorCard.countSavedNeighbours: OR of phone+device when phone
-- present (unlike get_saved_vendors' phone-only scoping — count intentionally
-- includes unmigrated device-only rows, matching the client's existing filter).

CREATE OR REPLACE FUNCTION public.get_saved_vendors_count(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_count integer;
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

  IF NOT public.check_and_log_rate_limit('get_saved_vendors_count', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.saved_vendors sv
  WHERE (
    CASE
      WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
        THEN (sv.user_phone = btrim(p_user_phone) OR sv.device_id = btrim(p_device_id))
      ELSE sv.device_id = btrim(p_device_id)
    END
  );

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.get_saved_vendors_count(text, text) IS
  'Count of own saved_vendors rows (phone OR device when phone present). Gates MAX_SAVED_NEIGHBOURS before saving.';

REVOKE ALL ON FUNCTION public.get_saved_vendors_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_saved_vendors_count(text, text) TO anon, authenticated, service_role;

-- ── 6. get_my_feed_flags ──────────────────────────────────────────────────────
-- Mirrors LocalFeed's "which of these posts did I already flag" read.

CREATE OR REPLACE FUNCTION public.get_my_feed_flags(
  p_user_phone text,
  p_post_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (post_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_feed_flags', 'phone', btrim(p_user_phone), 60, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT f.post_id
  FROM public.feed_flags f
  WHERE f.flagged_by_phone = btrim(p_user_phone)
    AND f.post_id = ANY (p_post_ids);
END;
$$;

COMMENT ON FUNCTION public.get_my_feed_flags(text, uuid[]) IS
  'post_ids among p_post_ids that the caller already flagged. OTP-off read path for LocalFeed flag state.';

REVOKE ALL ON FUNCTION public.get_my_feed_flags(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_feed_flags(text, uuid[]) TO anon, authenticated, service_role;

-- ── 7. get_my_addresses + drop the PROD world-read policy ─────────────────────
-- Mirrors useUserAddresses: device OR phone when phone present, else device.

CREATE OR REPLACE FUNCTION public.get_my_addresses(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  label text,
  address_text text,
  is_default boolean
)
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

  IF NOT public.check_and_log_rate_limit('get_my_addresses', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT a.id, a.label, a.address_text, a.is_default
  FROM public.user_addresses a
  WHERE (
    CASE
      WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
        THEN (a.device_id = btrim(p_device_id) OR a.user_phone = btrim(p_user_phone))
      ELSE a.device_id = btrim(p_device_id)
    END
  );
END;
$$;

COMMENT ON FUNCTION public.get_my_addresses(text, text) IS
  'Own saved addresses (device OR phone when phone present). OTP-off read path; replaces the direct read and the removed world-read SELECT policy.';

REVOKE ALL ON FUNCTION public.get_my_addresses(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_addresses(text, text) TO anon, authenticated, service_role;

-- PROD-only legacy policy: its `user_phone IS NOT NULL` arm makes every
-- phone-linked address row readable by anyone. No-op on TEST (already absent).
DROP POLICY IF EXISTS "Users can read own addresses" ON public.user_addresses;

-- ── 8. should_notify_vendor_order_edit ────────────────────────────────────────
-- Replaces MyOrders' broken push dedup, which read user_notifications WHERE
-- user_phone = <vendor phone> from the CUSTOMER's client — wrong owner, so RLS
-- returned zero rows and the dedup never fired (every edit always pushed).
-- The caller proves ownership of the request; the vendor's phone and their recent
-- order_update notifications are resolved server-side. Returns TRUE when a push
-- should be sent (no order_update notification for that vendor in the last 2 min).

CREATE OR REPLACE FUNCTION public.should_notify_vendor_order_edit(
  p_request_id uuid,
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_vendor_phone text;
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

  IF NOT public.check_and_log_rate_limit('should_notify_vendor_order_edit', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Caller must own the request (phone or device identity).
  SELECT btrim(v.phone) INTO v_vendor_phone
  FROM public.requests r
  JOIN public.vendors v ON v.id = r.vendor_id
  WHERE r.id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' AND r.user_phone = btrim(p_user_phone))
      OR (p_device_id IS NOT NULL AND btrim(p_device_id) <> '' AND r.device_id = btrim(p_device_id))
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  -- No vendor phone → nothing to dedup against; keep the push (matches the old
  -- client behaviour where the dedup check was skipped entirely).
  IF v_vendor_phone IS NULL OR v_vendor_phone = '' THEN
    RETURN true;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
    FROM public.user_notifications n
    WHERE n.user_phone = v_vendor_phone
      AND n.type = 'order_update'
      AND n.created_at > now() - interval '2 minutes'
  );
END;
$$;

COMMENT ON FUNCTION public.should_notify_vendor_order_edit(uuid, text, text) IS
  'TRUE when the vendor of the caller''s own request has no order_update notification in the last 2 min (push dedup for customer order edits). Fixes the wrong-owner client-side dedup read.';

REVOKE ALL ON FUNCTION public.should_notify_vendor_order_edit(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.should_notify_vendor_order_edit(uuid, text, text) TO anon, authenticated, service_role;
