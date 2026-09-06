-- Admin support-ticket read/resolve + customer phone lookup.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Gate/error/grant: is_admin_session + SECURITY DEFINER + authenticated-only EXECUTE
-- (same as admin_list_flagged_users / admin_force_clear_deletion).
-- support_messages previously had RLS on and no SELECT policy, so the admin
-- session could not read tickets in-app. Writes stay RPC-only (no UPDATE policy).

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

COMMENT ON COLUMN public.support_messages.resolved_at IS
  'Set by admin_resolve_support_message when an admin marks the ticket handled.';

CREATE INDEX IF NOT EXISTS support_messages_open_created_at_idx
  ON public.support_messages (created_at DESC)
  WHERE resolved_at IS NULL;

DROP POLICY IF EXISTS support_messages_admin_select ON public.support_messages;
CREATE POLICY support_messages_admin_select ON public.support_messages
  FOR SELECT
  TO authenticated
  USING (public.is_admin_session());

-- ── List ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_list_support_messages(
  p_include_resolved boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  kind text,
  category text,
  rating integer,
  message text,
  user_phone text,
  vendor_id uuid,
  vendor_shop_name text,
  device_id text,
  email_sent boolean,
  created_at timestamptz,
  resolved_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    sm.id,
    sm.kind,
    sm.category,
    sm.rating,
    sm.message,
    sm.user_phone,
    sm.vendor_id,
    v.shop_name,
    sm.device_id,
    sm.email_sent,
    sm.created_at,
    sm.resolved_at
  FROM public.support_messages sm
  LEFT JOIN public.vendors v ON v.id = sm.vendor_id
  WHERE p_include_resolved OR sm.resolved_at IS NULL
  ORDER BY (sm.resolved_at IS NULL) DESC, sm.created_at DESC
  LIMIT 100;
END;
$$;

COMMENT ON FUNCTION public.admin_list_support_messages(boolean) IS
  'Admin session: list Help & Support submissions (open by default; include resolved).';

REVOKE ALL ON FUNCTION public.admin_list_support_messages(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_support_messages(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_support_messages(boolean) TO authenticated;

-- ── Resolve ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_resolve_support_message(
  p_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  UPDATE public.support_messages
  SET resolved_at = now()
  WHERE id = p_id
    AND resolved_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 THEN
    PERFORM public.log_admin_action(
      NULL,
      'resolve_support_message',
      'support_message',
      p_id::text,
      NULL
    );
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.support_messages WHERE id = p_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- Already resolved: idempotent success.
END;
$$;

COMMENT ON FUNCTION public.admin_resolve_support_message(uuid) IS
  'Admin session: set support_messages.resolved_at. Audits on first resolve; already-resolved is a no-op.';

REVOKE ALL ON FUNCTION public.admin_resolve_support_message(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_resolve_support_message(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_support_message(uuid) TO authenticated;

-- ── Customer lookup ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_lookup_customer(
  p_phone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_phone text;
  v_user jsonb;
  v_vendor jsonb;
  v_orders jsonb;
  v_disputes jsonb;
  v_khata jsonb;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  v_phone := regexp_replace(btrim(COALESCE(p_phone, '')), '[^0-9]', '', 'g');
  IF length(v_phone) = 12 AND left(v_phone, 2) = '91' THEN
    v_phone := right(v_phone, 10);
  ELSIF length(v_phone) > 10 AND left(v_phone, 2) = '91' THEN
    v_phone := right(v_phone, 10);
  END IF;
  IF v_phone !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'invalid_phone_format';
  END IF;

  SELECT jsonb_build_object(
    'phone', u.phone,
    'trust_score', u.trust_score,
    'is_banned', COALESCE(u.is_banned, false),
    'ban_reason', u.ban_reason,
    'deletion_requested_at', u.deletion_requested_at,
    'warn_count', COALESCE(u.warn_count, 0),
    'noshow_count', COALESCE(u.noshow_count, 0),
    'fake_count', COALESCE(u.fake_count, 0)
  )
  INTO v_user
  FROM public.users u
  WHERE u.phone = v_phone;

  SELECT jsonb_build_object(
    'id', v.id,
    'shop_name', v.shop_name,
    'is_banned', COALESCE(v.is_banned, false),
    'deletion_requested_at', v.deletion_requested_at
  )
  INTO v_vendor
  FROM public.vendors v
  WHERE v.phone = v_phone
  LIMIT 1;

  SELECT COALESCE(
    jsonb_agg(item ORDER BY created_at DESC),
    '[]'::jsonb
  )
  INTO v_orders
  FROM (
    SELECT
      jsonb_build_object(
        'id', r.id,
        'status', r.status,
        'payment_status', COALESCE(r.payment_status, 'unpaid'),
        'service_mode', r.service_mode,
        'created_at', r.created_at,
        'vendor_id', r.vendor_id,
        'vendor_shop_name', ven.shop_name
      ) AS item,
      r.created_at
    FROM public.requests r
    LEFT JOIN public.vendors ven ON ven.id = r.vendor_id
    WHERE r.user_phone = v_phone
    ORDER BY r.created_at DESC
    LIMIT 25
  ) ord;

  SELECT COALESCE(
    jsonb_agg(item ORDER BY disputed_at DESC),
    '[]'::jsonb
  )
  INTO v_disputes
  FROM (
    SELECT
      jsonb_build_object(
        'id', d.id,
        'request_id', d.request_id,
        'vendor_id', d.vendor_id,
        'vendor_shop_name', ven.shop_name,
        'disputed_at', d.disputed_at
      ) AS item,
      d.disputed_at
    FROM public.payment_dispute_events d
    LEFT JOIN public.vendors ven ON ven.id = d.vendor_id
    WHERE d.user_phone = v_phone
    ORDER BY d.disputed_at DESC
    LIMIT 25
  ) dis;

  SELECT COALESCE(
    jsonb_agg(item ORDER BY last_updated DESC),
    '[]'::jsonb
  )
  INTO v_khata
  FROM (
    SELECT
      jsonb_build_object(
        'vendor_id', k.vendor_id,
        'vendor_shop_name', ven.shop_name,
        'total_outstanding', k.total_outstanding,
        'last_updated', k.last_updated
      ) AS item,
      k.last_updated
    FROM public.khata_ledger k
    LEFT JOIN public.vendors ven ON ven.id = k.vendor_id
    WHERE k.user_phone = v_phone
    ORDER BY k.last_updated DESC
    LIMIT 25
  ) kh;

  RETURN jsonb_build_object(
    'found',
      v_user IS NOT NULL
      OR v_vendor IS NOT NULL
      OR jsonb_array_length(COALESCE(v_orders, '[]'::jsonb)) > 0
      OR jsonb_array_length(COALESCE(v_disputes, '[]'::jsonb)) > 0
      OR jsonb_array_length(COALESCE(v_khata, '[]'::jsonb)) > 0,
    'phone', v_phone,
    'user', v_user,
    'vendor', v_vendor,
    'orders', COALESCE(v_orders, '[]'::jsonb),
    'disputes', COALESCE(v_disputes, '[]'::jsonb),
    'khata', COALESCE(v_khata, '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.admin_lookup_customer(text) IS
  'Admin session: customer case file by phone — flags, recent orders, disputes, Khata.';

REVOKE ALL ON FUNCTION public.admin_lookup_customer(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_lookup_customer(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_lookup_customer(text) TO authenticated;
