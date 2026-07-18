-- Vendor order/bill/khata read hardening (OTP-off identity model).
--
-- Confirmed live on PROD (2026-07-18): IncomingOrdersSection / LedgerView /
-- BillSheet / BillEditSheet / billEdit.ts read requests, order_bills,
-- khata_ledger, khata_transactions, order_items, and bill_edit_audit directly.
-- Every owner policy on those tables requires auth_user_phone(), which is NULL
-- under the real OTP-off localStorage identity model (VendorMode never mints a
-- Supabase Auth session). Anon no-session probes against a real PROD vendor
-- (rainbow painter / fce70d27-… / 9860900142) returned 0 rows where
-- service-role saw the vendor's real requests. All PROD requests are expired
-- with zero vendor engagement — consistent with vendors never seeing the inbox.
--
-- Same bug class as saved_vendors, vendor restore, and MyOrders (fixed earlier
-- tonight). This migration adds SECURITY DEFINER read RPCs with caller-supplied
-- vendor identity (p_vendor_id + p_vendor_phone), rate-limited via
-- check_and_log_rate_limit (30/min per vendor phone). Each RPC mirrors one
-- existing client query shape exactly — faithful lift-and-shift, not a redesign.
-- RLS stays restrictive — no USING(true).
--
-- RPCs:
--   1) get_vendor_incoming_orders          — IncomingOrders list (+ categories)
--   2) get_vendor_incoming_orders_count    — IncomingOrders head count
--   3) get_vendor_order_bills              — non-void bills for request ids
--   4) get_vendor_khata_ledger             — ledger strip (all or by phones)
--   5) get_vendor_khata_request_ids        — which terminal orders have khata txs
--   6) get_vendor_khata_dismiss_txs        — khata-mode txs for dismiss blocks
--   7) get_vendor_khata_transactions       — per-customer txs (optional since)
--   8) get_vendor_khata_linked_request     — latest request_id for paid notif
--   9) get_vendor_bill_line_items          — BillEditSheet line items
--  10) get_vendor_edited_bill_ids          — which bills have edit audit rows
--  11) get_vendor_bill_edit_audit          — BillEditHistorySheet rows
--  12) get_vendor_customer_trust           — trust badges on order cards
--       (users_owner also requires auth_user_phone(); companion fix so the
--        inbox is usable once orders are visible)

-- ── Shared identity helper (reads: no ban gate — mutations already gated) ────

CREATE OR REPLACE FUNCTION public._assert_vendor_identity(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_id IS NULL OR p_vendor_phone IS NULL OR btrim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = btrim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._assert_vendor_identity(uuid, text) IS
  'Asserts caller-supplied vendor id+phone match a real vendors row. Used by OTP-off vendor read RPCs.';

REVOKE ALL ON FUNCTION public._assert_vendor_identity(uuid, text) FROM PUBLIC;

-- Active-window predicate matching buildRequestsActiveWindowOrFilter("vendor")
-- plus the client''s trailing `,status.eq.fulfilled`:
--   sent(48h) | seen(24h) | accepted(48h) | cancelled(48h) | fulfilled(any)

-- ── 1. get_vendor_incoming_orders ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_incoming_orders(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  device_id text,
  vendor_id uuid,
  message text,
  status text,
  created_at timestamptz,
  user_phone text,
  delivery_address text,
  delivery_slot text,
  appointment_time timestamptz,
  appointment_status text,
  cancel_reason text,
  is_edited boolean,
  payment_status text,
  payment_utr text,
  customer_latitude double precision,
  customer_longitude double precision,
  category_id uuid,
  category_label text,
  category_emoji text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_incoming_orders', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));

  RETURN QUERY
  SELECT
    r.id,
    r.device_id,
    r.vendor_id,
    r.message,
    r.status,
    r.created_at,
    r.user_phone,
    r.delivery_address,
    r.delivery_slot,
    r.appointment_time,
    r.appointment_status,
    r.cancel_reason,
    r.is_edited,
    r.payment_status,
    r.payment_utr,
    r.customer_latitude,
    r.customer_longitude,
    r.category_id,
    c.label,
    c.emoji
  FROM public.requests r
  LEFT JOIN public.categories c ON c.id = r.category_id
  WHERE r.vendor_id = p_vendor_id
    AND (
      (r.status = 'sent' AND r.created_at >= now() - interval '48 hours')
      OR (r.status = 'seen' AND r.created_at >= now() - interval '24 hours')
      OR (r.status = 'accepted' AND r.created_at >= now() - interval '48 hours')
      OR (r.status = 'cancelled' AND r.created_at >= now() - interval '48 hours')
      OR r.status = 'fulfilled'
    )
  ORDER BY r.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_incoming_orders(uuid, text, integer) IS
  'OTP-off vendor inbox list. Mirrors IncomingOrdersSection active-window filter + fulfilled.';

REVOKE ALL ON FUNCTION public.get_vendor_incoming_orders(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_incoming_orders(uuid, text, integer) TO anon, authenticated, service_role;

-- ── 2. get_vendor_incoming_orders_count ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_incoming_orders_count(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_incoming_orders_count', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT count(*)::bigint INTO v_count
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id
    AND (
      (r.status = 'sent' AND r.created_at >= now() - interval '48 hours')
      OR (r.status = 'seen' AND r.created_at >= now() - interval '24 hours')
      OR (r.status = 'accepted' AND r.created_at >= now() - interval '48 hours')
      OR (r.status = 'cancelled' AND r.created_at >= now() - interval '48 hours')
      OR r.status = 'fulfilled'
    );

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.get_vendor_incoming_orders_count(uuid, text) IS
  'OTP-off vendor inbox exact count for the same active-window filter as the list RPC.';

REVOKE ALL ON FUNCTION public.get_vendor_incoming_orders_count(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_incoming_orders_count(uuid, text) TO anon, authenticated, service_role;

-- ── 3. get_vendor_order_bills ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_order_bills(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  request_id uuid,
  total_amount double precision,
  payment_mode text,
  payment_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_order_bills', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    b.id,
    b.request_id,
    b.total_amount,
    b.payment_mode,
    b.payment_status
  FROM public.order_bills b
  INNER JOIN public.requests r ON r.id = b.request_id
  WHERE r.vendor_id = p_vendor_id
    AND b.request_id = ANY (p_request_ids)
    AND b.payment_status <> 'void';
END;
$$;

COMMENT ON FUNCTION public.get_vendor_order_bills(uuid, text, uuid[]) IS
  'OTP-off non-void bills for the vendor''s own request ids (IncomingOrders / BillSheet exists-check).';

REVOKE ALL ON FUNCTION public.get_vendor_order_bills(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_order_bills(uuid, text, uuid[]) TO anon, authenticated, service_role;

-- ── 4. get_vendor_khata_ledger ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_khata_ledger(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_user_phones text[] DEFAULT NULL
)
RETURNS TABLE (
  user_phone text,
  total_outstanding double precision,
  last_updated timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_ledger', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- NULL / empty phones → full ledger (LedgerView).
  -- Non-empty → phone-filtered batch (IncomingOrders dismiss blocks / outstanding).
  RETURN QUERY
  SELECT
    k.user_phone,
    k.total_outstanding,
    k.last_updated
  FROM public.khata_ledger k
  WHERE k.vendor_id = p_vendor_id
    AND (
      p_user_phones IS NULL
      OR cardinality(p_user_phones) = 0
      OR k.user_phone = ANY (p_user_phones)
    )
  ORDER BY k.last_updated DESC NULLS LAST;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_ledger(uuid, text, text[]) IS
  'OTP-off khata_ledger for a vendor. Optional phone filter; empty/null = all entries.';

REVOKE ALL ON FUNCTION public.get_vendor_khata_ledger(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_ledger(uuid, text, text[]) TO anon, authenticated, service_role;

-- ── 5. get_vendor_khata_request_ids ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_khata_request_ids(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_request_ids', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT t.request_id
  FROM public.khata_transactions t
  WHERE t.vendor_id = p_vendor_id
    AND t.request_id = ANY (p_request_ids)
    AND t.request_id IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_request_ids(uuid, text, uuid[]) IS
  'OTP-off: which of the vendor''s terminal request ids have any khata_transactions row.';

REVOKE ALL ON FUNCTION public.get_vendor_khata_request_ids(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_request_ids(uuid, text, uuid[]) TO anon, authenticated, service_role;

-- ── 6. get_vendor_khata_dismiss_txs ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_khata_dismiss_txs(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid,
  user_phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_dismiss_txs', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.request_id, t.user_phone
  FROM public.khata_transactions t
  WHERE t.vendor_id = p_vendor_id
    AND t.payment_mode = 'khata'
    AND t.request_id = ANY (p_request_ids);
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_dismiss_txs(uuid, text, uuid[]) IS
  'OTP-off khata-mode transactions used by IncomingOrders unpaid-dismiss blocks.';

REVOKE ALL ON FUNCTION public.get_vendor_khata_dismiss_txs(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_dismiss_txs(uuid, text, uuid[]) TO anon, authenticated, service_role;

-- ── 7. get_vendor_khata_transactions ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_khata_transactions(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_user_phone text,
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  amount numeric,
  note text,
  payment_mode text,
  created_at timestamptz,
  request_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_transactions', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- p_since NULL → full history ASC (LedgerView current-cycle client filter).
  -- p_since set  → created_at >= since, DESC (LedgerView full-history sheet).
  IF p_since IS NULL THEN
    RETURN QUERY
    SELECT t.id, t.amount, t.note, t.payment_mode, t.created_at, t.request_id
    FROM public.khata_transactions t
    WHERE t.vendor_id = p_vendor_id
      AND t.user_phone = v_phone
    ORDER BY t.created_at ASC;
  ELSE
    RETURN QUERY
    SELECT t.id, t.amount, t.note, t.payment_mode, t.created_at, t.request_id
    FROM public.khata_transactions t
    WHERE t.vendor_id = p_vendor_id
      AND t.user_phone = v_phone
      AND t.created_at >= p_since
    ORDER BY t.created_at DESC;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_transactions(uuid, text, text, timestamptz) IS
  'OTP-off per-customer khata_transactions. Optional p_since switches to full-history DESC.';

REVOKE ALL ON FUNCTION public.get_vendor_khata_transactions(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_transactions(uuid, text, text, timestamptz) TO anon, authenticated, service_role;

-- ── 8. get_vendor_khata_linked_request ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_khata_linked_request(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_user_phone text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_request_id uuid;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  IF v_phone IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_linked_request', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT t.request_id INTO v_request_id
  FROM public.khata_transactions t
  WHERE t.vendor_id = p_vendor_id
    AND t.user_phone = v_phone
    AND t.request_id IS NOT NULL
  ORDER BY t.created_at DESC
  LIMIT 1;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_linked_request(uuid, text, text) IS
  'OTP-off: latest non-null request_id on a customer''s khata txs (paid-notification deep link).';

REVOKE ALL ON FUNCTION public.get_vendor_khata_linked_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_linked_request(uuid, text, text) TO anon, authenticated, service_role;

-- ── 9. get_vendor_bill_line_items ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_bill_line_items(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_id uuid
)
RETURNS TABLE (
  description text,
  quantity double precision,
  unit text,
  unit_price double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_bill_line_items', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_request_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.requests r
    WHERE r.id = p_request_id AND r.vendor_id = p_vendor_id
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    i.description,
    i.quantity,
    i.unit,
    i.unit_price,
    i.created_at
  FROM public.order_items i
  WHERE i.request_id = p_request_id
  ORDER BY i.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_bill_line_items(uuid, text, uuid) IS
  'OTP-off order_items for a request owned by the calling vendor (BillEditSheet).';

REVOKE ALL ON FUNCTION public.get_vendor_bill_line_items(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_bill_line_items(uuid, text, uuid) TO anon, authenticated, service_role;

-- ── 10. get_vendor_edited_bill_ids ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_edited_bill_ids(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_bill_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  bill_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_edited_bill_ids', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_bill_ids IS NULL OR cardinality(p_bill_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT a.bill_id
  FROM public.bill_edit_audit a
  INNER JOIN public.order_bills b ON b.id = a.bill_id
  INNER JOIN public.requests r ON r.id = b.request_id
  WHERE r.vendor_id = p_vendor_id
    AND a.bill_id = ANY (p_bill_ids);
END;
$$;

COMMENT ON FUNCTION public.get_vendor_edited_bill_ids(uuid, text, uuid[]) IS
  'OTP-off: which of the vendor''s bill ids have at least one bill_edit_audit row.';

REVOKE ALL ON FUNCTION public.get_vendor_edited_bill_ids(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_edited_bill_ids(uuid, text, uuid[]) TO anon, authenticated, service_role;

-- ── 11. get_vendor_bill_edit_audit ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_bill_edit_audit(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_bill_id uuid
)
RETURNS TABLE (
  id uuid,
  bill_id uuid,
  edited_at timestamptz,
  reason text,
  old_total numeric,
  new_total numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_bill_edit_audit', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_bill_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.order_bills b
    INNER JOIN public.requests r ON r.id = b.request_id
    WHERE b.id = p_bill_id AND r.vendor_id = p_vendor_id
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.bill_id,
    a.edited_at,
    a.reason,
    a.old_total,
    a.new_total
  FROM public.bill_edit_audit a
  WHERE a.bill_id = p_bill_id
  ORDER BY a.edited_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_bill_edit_audit(uuid, text, uuid) IS
  'OTP-off bill_edit_audit history for a bill owned by the calling vendor.';

REVOKE ALL ON FUNCTION public.get_vendor_bill_edit_audit(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_bill_edit_audit(uuid, text, uuid) TO anon, authenticated, service_role;

-- ── 12. get_vendor_customer_trust ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_vendor_customer_trust(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_phones text[] DEFAULT NULL
)
RETURNS TABLE (
  phone text,
  trust_score double precision,
  total_orders integer,
  is_banned boolean,
  ban_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_customer_trust', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_phones IS NULL OR cardinality(p_phones) = 0 THEN
    RETURN;
  END IF;

  -- Only return trust for phones that have (or had) a request with this vendor.
  RETURN QUERY
  SELECT
    u.phone,
    u.trust_score,
    u.total_orders,
    u.is_banned,
    u.ban_reason
  FROM public.users u
  WHERE u.phone = ANY (p_phones)
    AND EXISTS (
      SELECT 1
      FROM public.requests r
      WHERE r.vendor_id = p_vendor_id
        AND r.user_phone = u.phone
    );
END;
$$;

COMMENT ON FUNCTION public.get_vendor_customer_trust(uuid, text, text[]) IS
  'OTP-off trust badges for customers who have ordered from this vendor.';

REVOKE ALL ON FUNCTION public.get_vendor_customer_trust(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_customer_trust(uuid, text, text[]) TO anon, authenticated, service_role;

-- ── Companion: get_my_bill_edit_audit (customer BillEditHistorySheet) ────────
-- BillEditHistorySheet is shared by IncomingOrders (vendor) and MyOrders
-- (customer). Vendor path uses get_vendor_bill_edit_audit above; customer path
-- needs the same OTP-off treatment (bill_edit_audit RLS also uses auth_user_phone).

CREATE OR REPLACE FUNCTION public.get_my_bill_edit_audit(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_bill_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  bill_id uuid,
  edited_at timestamptz,
  reason text,
  old_total numeric,
  new_total numeric
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

  IF NOT public.check_and_log_rate_limit('get_my_bill_edit_audit', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_bill_id IS NULL THEN
    RETURN;
  END IF;

  -- Bill must belong to one of the caller's own requests.
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_bills b
    INNER JOIN public.requests r ON r.id = b.request_id
    WHERE b.id = p_bill_id
      AND (
        CASE
          WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
            THEN r.user_phone = btrim(p_user_phone)
          ELSE r.device_id = btrim(p_device_id)
        END
      )
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.bill_id,
    a.edited_at,
    a.reason,
    a.old_total,
    a.new_total
  FROM public.bill_edit_audit a
  WHERE a.bill_id = p_bill_id
  ORDER BY a.edited_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_bill_edit_audit(text, text, uuid) IS
  'OTP-off bill_edit_audit for a bill on the caller''s own request (MyOrders history sheet).';

REVOKE ALL ON FUNCTION public.get_my_bill_edit_audit(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_bill_edit_audit(text, text, uuid) TO anon, authenticated, service_role;
