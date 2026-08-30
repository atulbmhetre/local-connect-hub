-- TEST: hybrid session identity on Group 1 profile/UPI RPCs (the audit's
-- worst remaining gap). Rate-limit + SMS finish logic is unchanged; this
-- only adds _assert_vendor_session_matches at BEGIN. No-op without Auth
-- session.

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

REVOKE ALL ON FUNCTION public._assert_vendor_session_matches(uuid, text) FROM PUBLIC;

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
        'vendor_update_own',
        'vendor_update_profile_and_categories',
        'vendor_update_categories',
        'vendor_verify_upi'
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
      RAISE EXCEPTION 'group-1 session-hybrid inject failed for %', r.proname;
    END IF;

    EXECUTE injected;
    RAISE NOTICE 'injected session hybrid: %', r.proname;
  END LOOP;
END;
$inject$;
