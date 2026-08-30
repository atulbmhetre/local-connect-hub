-- TEST: extend hybrid session identity to bucket-2 order-lifecycle and
-- standing/safety RPCs. Helpers already exist from 20260829210001; CREATE OR
-- REPLACE keeps this file self-contained. No-op without Auth session.

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
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'vendor_accept_order',
        'vendor_cancel_order',
        'vendor_decline_booking',
        'vendor_dismiss_requests',
        'vendor_confirm_appointment',
        'mark_vendor_order_started',
        'upsert_vendor_device',
        'vendor_submit_user_flag',
        'vendor_update_availability_modes',
        'vendor_sync_category_modes',
        'send_bill_payment_reminder'
      )
    ORDER BY p.proname, p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('public._assert_vendor_session_matches' IN def) > 0 THEN
      RAISE NOTICE 'already injected: % (%)', r.proname, r.oid;
      CONTINUE;
    END IF;

    IF r.proname = 'send_bill_payment_reminder' THEN
      -- Cron path has no vendor identity (p_vendor_id NULL). Only gate
      -- p_source = 'vendor' so a leftover Auth session cannot break cron.
      perform_stmt :=
        '  IF p_source = ''vendor'' THEN' || E'\n' ||
        '    PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);' || E'\n' ||
        '  END IF;';
    ELSE
      perform_stmt :=
        '  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);';
    END IF;

    injected := regexp_replace(
      def,
      E'(AS \\$function\\$[\\s\\S]*?BEGIN\\r?\\n)',
      E'\\1' || perform_stmt || E'\n\n'
    );

    IF injected IS NULL OR injected = def THEN
      RAISE EXCEPTION 'bucket-2 session-hybrid inject failed for %', r.proname;
    END IF;

    EXECUTE injected;
    RAISE NOTICE 'injected session hybrid: %', r.proname;
  END LOOP;
END;
$inject$;
