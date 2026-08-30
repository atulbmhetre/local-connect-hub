-- TEST: hybrid identity on bucket-1 financial RPCs.
-- If auth_user_phone() is set, it MUST match this vendor (session wins; a
-- matching p_vendor_phone cannot authorize a different vendor). If there is
-- no session, existing p_vendor_phone checks are unchanged (old client).

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

COMMENT ON FUNCTION public._assert_vendor_session_matches(uuid, text) IS
  'No-op without Auth session. With a session, vendor row phone and optional p_vendor_phone must match auth_user_phone().';

CREATE OR REPLACE FUNCTION public._assert_vendor_session_matches_request(
  p_request_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(public.auth_user_phone(), '')), '') IS NULL THEN
    RETURN;
  END IF;

  SELECT r.vendor_id
  INTO v_vendor_id
  FROM public.requests r
  WHERE r.id = p_request_id;

  IF v_vendor_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM public._assert_vendor_session_matches(v_vendor_id, p_vendor_phone);
END;
$$;

COMMENT ON FUNCTION public._assert_vendor_session_matches_request(uuid, text) IS
  'Session hybrid for request-keyed RPCs (confirm/dispute UPI).';

REVOKE ALL ON FUNCTION public._assert_vendor_session_matches(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._assert_vendor_session_matches_request(uuid, text) FROM PUBLIC;

DO $inject$
DECLARE
  r record;
  def text;
  injected text;
  perform_stmt text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'insert_bill_with_items',
        'add_bill_to_khata',
        'vendor_mark_bill_paid',
        'confirm_upi_payment',
        'dispute_upi_payment',
        'vendor_edit_bill',
        'vendor_record_khata_payment',
        'vendor_record_khata_refund',
        'vendor_void_unpaid_bills'
      )
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('public._assert_vendor_session_matches' IN def) > 0 THEN
      RAISE NOTICE 'already injected: %', r.proname;
      CONTINUE;
    END IF;

    IF r.proname IN ('confirm_upi_payment', 'dispute_upi_payment') THEN
      perform_stmt :=
        '  PERFORM public._assert_vendor_session_matches_request(p_request_id, p_vendor_phone);';
    ELSE
      perform_stmt :=
        '  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);';
    END IF;

    injected := regexp_replace(
      def,
      E'(AS \\$function\\$[\\s\\S]*?BEGIN\\n)',
      E'\\1' || perform_stmt || E'\n\n'
    );

    IF injected IS NULL OR injected = def THEN
      RAISE EXCEPTION 'session-hybrid inject failed for %', r.proname;
    END IF;

    EXECUTE injected;
    RAISE NOTICE 'injected session hybrid: %', r.proname;
  END LOOP;
END;
$inject$;
