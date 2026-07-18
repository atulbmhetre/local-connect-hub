-- Vendor settings/stats/location read hardening (OTP-off identity model).
--
-- Follow-up to 20260718030001: remaining vendor-side direct reads flagged in
-- tonight's discovery scan. All hit tables whose owner RLS requires
-- auth_user_phone() (NULL under OTP-off), so they silently return zero rows in
-- production:
--   * VendorMode.tsx        — requests (go-offline blocking orders, order stats)
--   * vendorBackgroundLocation.ts — requests (accepted orders for tracking restore)
--   * VendorSettings.tsx    — khata_ledger (outstanding gate on khata toggle-off)
--   * Settings.tsx          — vendor_credits (referral credits panel)
--   * Settings.tsx          — vendors.deletion_requested_at by phone (deletion
--                             status; vendors public read excludes hidden/draft)
--
-- Same pattern: SECURITY DEFINER RPCs, caller-supplied vendor identity
-- (_assert_vendor_identity), rate-limited via check_and_log_rate_limit
-- (30/min per phone), faithful lift-and-shift of each query shape.
-- RLS stays restrictive — no USING(true).
--
-- Also folds the client-side green-criteria pre-read (vendorGreenReady.ts read
-- vendors directly — broken for hidden/draft vendors) into
-- vendor_promote_green_pending itself, which already re-checked most criteria.

-- ── 1. get_vendor_blocking_active_orders (VendorMode go-offline gate) ────────

CREATE OR REPLACE FUNCTION public.get_vendor_blocking_active_orders(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS TABLE (
  id uuid,
  status text,
  appointment_status text,
  user_phone text,
  delivery_slot text,
  appointment_time timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_blocking_active_orders', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.id, r.status, r.appointment_status, r.user_phone,
         r.delivery_slot, r.appointment_time
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id
    AND r.status IN ('sent', 'seen', 'accepted');
END;
$$;

COMMENT ON FUNCTION public.get_vendor_blocking_active_orders(uuid, text) IS
  'OTP-off: active (sent/seen/accepted) requests used by the go-offline blocking check.';

REVOKE ALL ON FUNCTION public.get_vendor_blocking_active_orders(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_blocking_active_orders(uuid, text) TO anon, authenticated, service_role;

-- ── 2. get_vendor_order_stats_rows (VendorMode stats panel) ──────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_order_stats_rows(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS TABLE (
  status text,
  appointment_status text,
  created_at timestamptz,
  category_id uuid,
  delivery_slot_deadline timestamptz,
  fulfilled_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_order_stats_rows', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.status, r.appointment_status, r.created_at, r.category_id,
         r.delivery_slot_deadline, r.fulfilled_at
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_order_stats_rows(uuid, text) IS
  'OTP-off: all request rows (stats fields only) for the vendor order-stats panel.';

REVOKE ALL ON FUNCTION public.get_vendor_order_stats_rows(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_order_stats_rows(uuid, text) TO anon, authenticated, service_role;

-- ── 3. get_vendor_accepted_orders (background location restore) ──────────────

CREATE OR REPLACE FUNCTION public.get_vendor_accepted_orders(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS TABLE (
  id uuid,
  status text,
  created_at timestamptz,
  delivery_slot text,
  appointment_time timestamptz,
  appointment_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_accepted_orders', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.id, r.status, r.created_at, r.delivery_slot,
         r.appointment_time, r.appointment_status
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id
    AND r.status = 'accepted';
END;
$$;

COMMENT ON FUNCTION public.get_vendor_accepted_orders(uuid, text) IS
  'OTP-off: accepted requests for background order-tracking restore.';

REVOKE ALL ON FUNCTION public.get_vendor_accepted_orders(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_accepted_orders(uuid, text) TO anon, authenticated, service_role;

-- ── 4. get_vendor_khata_has_outstanding (khata toggle-off gate) ──────────────

CREATE OR REPLACE FUNCTION public.get_vendor_khata_has_outstanding(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_has_outstanding', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.khata_ledger k
    WHERE k.vendor_id = p_vendor_id
      AND k.total_outstanding > 0
  );
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_has_outstanding(uuid, text) IS
  'OTP-off: whether any customer khata is outstanding (blocks disabling khata).';

REVOKE ALL ON FUNCTION public.get_vendor_khata_has_outstanding(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_has_outstanding(uuid, text) TO anon, authenticated, service_role;

-- ── 5. get_vendor_credits (referral credits panel) ───────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_credits(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS TABLE (
  amount numeric,
  disbursed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_credits', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT c.amount, c.disbursed
  FROM public.vendor_credits c
  WHERE c.vendor_id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_credits(uuid, text) IS
  'OTP-off: vendor''s own referral credits (amount + disbursed flag).';

REVOKE ALL ON FUNCTION public.get_vendor_credits(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_credits(uuid, text) TO anon, authenticated, service_role;

-- ── 6. get_vendor_deletion_status (Settings deletion checks, by phone) ───────
-- vendors public read excludes hidden/draft vendors, and get_vendor_by_phone_login
-- deliberately excludes deletion-requested rows, so neither can report deletion
-- status. Phone knowledge = identity, same trust model as get_vendor_restore_status.

CREATE OR REPLACE FUNCTION public.get_vendor_deletion_status(
  p_phone text
)
RETURNS TABLE (
  vendor_id uuid,
  deletion_requested_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(btrim(COALESCE(p_phone, '')), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_deletion_status', 'phone', v_phone, 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT v.id, v.deletion_requested_at
  FROM public.vendors v
  WHERE v.phone = v_phone
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_deletion_status(text) IS
  'OTP-off: vendor existence + deletion_requested_at by own phone (Settings deletion UI).';

REVOKE ALL ON FUNCTION public.get_vendor_deletion_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_deletion_status(text) TO anon, authenticated, service_role;

-- ── 7. vendor_promote_green_pending: fold client pre-read criteria in ────────
-- vendorGreenReady.ts used to read the vendors row directly (broken for
-- hidden/draft vendors) to check meetsGreenCriteria before calling this RPC.
-- Move those checks server-side so the client can call unconditionally:
--   * verification_status must be 'business_verified' (client checked this;
--     the old body only required "not already green_pending")
--   * phone must be a plausible Indian mobile (client isValidPhone)
-- Existing checks kept: not manual-verified, photo present, UPI verified.

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
    AND v.verification_status = 'business_verified'
    AND v.is_manual_verified IS NOT TRUE
    AND v.shop_photo_url IS NOT NULL
    AND v.upi_verified IS TRUE
    AND regexp_replace(COALESCE(v.phone, ''), '[\s-]', '', 'g') ~ '^(\+?91)?[6-9][0-9]{9}$';

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.vendor_promote_green_pending(uuid) IS
  'Marks green_pending when full green criteria met (all checks server-side; idempotent).';
