-- TEST: hybrid session identity on bucket-3 reads and easily-reversed edits.
-- Helpers already exist; CREATE OR REPLACE keeps this file self-contained.
-- get_vendor_customer_names is LANGUAGE sql + phone-only (no p_vendor_id);
-- rewritten to plpgsql with a phone-only session assert instead of stuffing
-- a fake vendor id into the shared helper.

CREATE OR REPLACE FUNCTION public._assert_vendor_session_matches(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session text;
  v_row_phone text;
  v_param text;
BEGIN
  v_session := NULLIF(btrim(COALESCE(public.auth_user_phone(), '')), '');
  IF v_session IS NULL THEN
    RETURN;
  END IF;

  IF p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  SELECT v.phone
  INTO v_row_phone
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF v_row_phone IS NULL OR v_row_phone IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_param := NULLIF(btrim(COALESCE(p_vendor_phone, '')), '');
  IF v_param IS NOT NULL AND v_param IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._assert_vendor_session_matches_phone(
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session text;
  v_param text;
BEGIN
  v_session := NULLIF(btrim(COALESCE(public.auth_user_phone(), '')), '');
  IF v_session IS NULL THEN
    RETURN;
  END IF;

  v_param := NULLIF(btrim(COALESCE(p_vendor_phone, '')), '');
  IF v_param IS NULL OR v_param IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_vendor_session_matches(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._assert_vendor_session_matches_phone(text) FROM PUBLIC;

DO $inject$
DECLARE
  r record;
  def text;
  injected text;
  perform_stmt text;
BEGIN
  perform_stmt :=
    '  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);';

  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_vendor_incoming_orders',
        'get_vendor_incoming_orders_count',
        'get_vendor_accepted_orders',
        'get_vendor_blocking_active_orders',
        'get_vendor_order_stats_rows',
        'get_vendor_own',
        'get_vendor_credits',
        'get_vendor_customer_trust',
        'get_vendor_order_bills',
        'get_vendor_bill_line_items',
        'get_vendor_edited_bill_ids',
        'get_vendor_bill_edit_audit',
        'get_vendor_khata_ledger',
        'get_vendor_khata_transactions',
        'get_vendor_khata_request_ids',
        'get_vendor_khata_dismiss_txs',
        'get_vendor_khata_linked_request',
        'get_vendor_khata_has_outstanding',
        'vendor_insert_menu_items',
        'vendor_update_menu_item',
        'vendor_delete_menu_item',
        'vendor_toggle_menu_item_availability',
        'vendor_update_customer_name',
        'vendor_upsert_category_cancel_reasons',
        'vendor_update_category_profile',
        'attach_pending_category',
        'vendor_find_colocated_category',
        'vendor_mark_sent_seen',
        'vendor_clear_order_edited'
      )
    ORDER BY p.proname, p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('public._assert_vendor_session_matches' IN def) > 0 THEN
      RAISE NOTICE 'already injected: % (%)', r.proname, r.oid;
      CONTINUE;
    END IF;

    injected := regexp_replace(
      def,
      E'(AS \\$function\\$[\\s\\S]*?BEGIN\\r?\\n)',
      E'\\1' || perform_stmt || E'\n\n'
    );

    IF injected IS NULL OR injected = def THEN
      RAISE EXCEPTION 'bucket-3 session-hybrid inject failed for %', r.proname;
    END IF;

    EXECUTE injected;
    RAISE NOTICE 'injected session hybrid: %', r.proname;
  END LOOP;
END;
$inject$;

CREATE OR REPLACE FUNCTION public.get_vendor_customer_names(
  p_vendor_phone text
)
RETURNS TABLE(phone text, name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_session_matches_phone(p_vendor_phone);

  RETURN QUERY
  SELECT
    kl.user_phone AS phone,
    NULLIF(TRIM(au.name), '') AS name
  FROM public.khata_ledger kl
  INNER JOIN public.vendors v ON v.id = kl.vendor_id
  LEFT JOIN public.app_users au ON au.phone = kl.user_phone
  WHERE v.phone = p_vendor_phone
    AND kl.user_phone IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_customer_names(text) IS
  'Returns customer phone/name pairs for a vendor khata ledger. SECURITY DEFINER. Session present must match p_vendor_phone.';

REVOKE ALL ON FUNCTION public.get_vendor_customer_names(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_customer_names(text) TO anon, authenticated;
