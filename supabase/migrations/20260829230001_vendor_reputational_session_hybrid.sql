-- TEST: extend hybrid session identity to remaining reputational/cosmetic
-- RPCs. Helpers already exist from 20260829210001; CREATE OR REPLACE keeps
-- this file self-contained. No-op without Auth session.

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
        'vendor_reply_to_review',
        'vendor_post_offer',
        'vendor_hide_feed_post',
        'submit_vendor_verification',
        'vendor_submit_category_shop_photo',
        'vendor_clear_category_photo_verifications',
        'vendor_promote_green_pending',
        'vendor_promote_category_green_pending',
        'vendor_inherit_colocated_shop_photo'
      )
    ORDER BY p.proname, p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('public._assert_vendor_session_matches' IN def) > 0 THEN
      RAISE NOTICE 'already injected: % (%)', r.proname, r.oid;
      CONTINUE;
    END IF;

    perform_stmt :=
      '  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);';

    injected := regexp_replace(
      def,
      E'(AS \\$function\\$[\\s\\S]*?BEGIN\\r?\\n)',
      E'\\1' || perform_stmt || E'\n\n'
    );

    IF injected IS NULL OR injected = def THEN
      RAISE EXCEPTION 'reputational session-hybrid inject failed for %', r.proname;
    END IF;

    EXECUTE injected;
    RAISE NOTICE 'injected session hybrid: %', r.proname;
  END LOOP;
END;
$inject$;
