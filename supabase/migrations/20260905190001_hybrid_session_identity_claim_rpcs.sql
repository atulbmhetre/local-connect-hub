-- Soft hybrid session assert on identity-claiming RPCs (TEST first).
-- Scope (exact): register_vendor, ensure_user_device_link, upsert_app_user,
-- get_vendor_by_phone_login, migrate_saved_vendors_phone,
-- migrate_device_requests_phone, apply_user_referral.
-- NOT in scope: get_vendor_deletion_status, vendor_fulfil_order (already hybrid).
--
-- Same soft hybrid as Session 77 / 20260905120001:
--   auth_user_phone() set  → claimed phone MUST match session (else not_found_or_unauthorized)
--   auth_user_phone() null → no-op (OTP-off unchanged)
-- Claimed phones are digit-normalized to 10 (strip 91… / non-digits) before compare,
-- matching get_vendor_by_phone_login / auth_user_phone() conventions.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public._assert_session_matches_claimed_phone(
  p_phone text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session text;
  v_digits text;
BEGIN
  v_session := NULLIF(btrim(COALESCE(public.auth_user_phone(), '')), '');
  IF v_session IS NULL THEN
    RETURN;
  END IF;

  v_digits := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) = 12 AND v_digits LIKE '91%' THEN
    v_digits := right(v_digits, 10);
  ELSIF length(v_digits) = 11 AND v_digits LIKE '1%' THEN
    v_digits := right(v_digits, 10);
  END IF;

  IF v_digits IS NULL OR length(v_digits) <> 10 OR v_digits IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._assert_session_matches_claimed_phone(text) IS
  'Soft hybrid: when auth_user_phone() is set, claimed phone (normalized to 10 digits) must match; no-op when session phone is null (OTP-off).';

REVOKE ALL ON FUNCTION public._assert_session_matches_claimed_phone(text) FROM PUBLIC;

DO $inject$
DECLARE
  r record;
  def text;
  injected text;
  perform_stmt text;
BEGIN
  FOR r IN
    SELECT
      p.oid,
      p.proname,
      CASE p.proname
        WHEN 'register_vendor' THEN 'p_phone'
        WHEN 'ensure_user_device_link' THEN 'p_user_phone'
        WHEN 'upsert_app_user' THEN 'p_phone'
        WHEN 'get_vendor_by_phone_login' THEN 'p_phone'
        WHEN 'migrate_saved_vendors_phone' THEN 'p_user_phone'
        WHEN 'migrate_device_requests_phone' THEN 'p_user_phone'
        WHEN 'apply_user_referral' THEN 'p_phone'
      END AS phone_arg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'register_vendor',
        'ensure_user_device_link',
        'upsert_app_user',
        'get_vendor_by_phone_login',
        'migrate_saved_vendors_phone',
        'migrate_device_requests_phone',
        'apply_user_referral'
      )
    ORDER BY p.proname, p.oid
  LOOP
    IF r.phone_arg IS NULL THEN
      RAISE EXCEPTION 'identity-claim hybrid: missing phone_arg map for %', r.proname;
    END IF;

    def := pg_get_functiondef(r.oid);
    IF position('public._assert_session_matches_claimed_phone' IN def) > 0 THEN
      RAISE NOTICE 'already injected: % (%)', r.proname, r.oid;
      CONTINUE;
    END IF;

    perform_stmt :=
      '  PERFORM public._assert_session_matches_claimed_phone(' || r.phone_arg || ');';

    injected := regexp_replace(
      def,
      E'(AS \\$function\\$[\\s\\S]*?BEGIN\\r?\\n)',
      E'\\1' || perform_stmt || E'\n\n'
    );

    IF injected IS NULL OR injected = def THEN
      RAISE EXCEPTION 'identity-claim session-hybrid inject failed for %', r.proname;
    END IF;

    EXECUTE injected;
    RAISE NOTICE 'injected identity-claim session hybrid: % (%s)', r.proname, r.phone_arg;
  END LOOP;
END;
$inject$;

COMMENT ON FUNCTION public.register_vendor IS
  'Atomic vendor registration. Soft hybrid: session phone must match p_phone when Auth is present; OTP-off unchanged.';

COMMENT ON FUNCTION public.ensure_user_device_link(text, text) IS
  'Ensure user_devices row for phone+device. Soft hybrid: session phone must match p_user_phone when Auth is present; OTP-off unchanged.';

COMMENT ON FUNCTION public.upsert_app_user(text, text) IS
  'Upsert public.users (and optional app_users.lang). Soft hybrid: session phone must match p_phone when Auth is present; OTP-off unchanged.';

COMMENT ON FUNCTION public.get_vendor_by_phone_login(text, text) IS
  'Vendor login lookup by phone; full row on success. Soft hybrid: session phone must match p_phone when Auth is present; OTP-off unchanged. Rate-limited 10/min per caller device_id and per target phone.';

COMMENT ON FUNCTION public.migrate_saved_vendors_phone(text, text) IS
  'Attach device-scoped saved_vendors rows to p_user_phone. Soft hybrid: session phone must match p_user_phone when Auth is present; OTP-off unchanged.';

COMMENT ON FUNCTION public.migrate_device_requests_phone(text, text) IS
  'Attach device-scoped requests to p_user_phone. Soft hybrid: session phone must match p_user_phone when Auth is present; OTP-off unchanged.';

COMMENT ON FUNCTION public.apply_user_referral(text, text, text) IS
  'Atomic apply referral for joining user phone. Soft hybrid: session phone must match p_phone when Auth is present; OTP-off unchanged.';
