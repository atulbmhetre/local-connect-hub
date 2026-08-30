-- TEST-only: rewrite _test_set_vendor_update_own_ban_assert so its
-- strip/restore of the go-live ban+photos gate is not BEGIN-anchored.
-- Session-hybrid injects PERFORM _assert_vendor_session_matches at the
-- first BEGIN of vendor_update_own; the old exact-string replace looked
-- for BEGIN immediately followed by the is_active IF and raised
-- 'failed to strip ban gate from vendor_update_own'. This helper now
-- targets only that IF block (and re-inserts it before identity_required),
-- leaving the session-hybrid PERFORM untouched.

CREATE OR REPLACE FUNCTION public._test_set_vendor_update_own_ban_assert(p_enabled boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  def text;
  v_gate text;
  v_gate_crlf text;
  v_identity text;
  v_stripped text;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p
  WHERE p.proname = 'vendor_update_own'
    AND p.pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'vendor_update_own missing';
  END IF;

  v_gate :=
    E'  IF p_patch ? ''is_active'' AND (p_patch->>''is_active'')::boolean IS TRUE THEN\n'
    || E'    PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);\n'
    || E'    PERFORM public._assert_vendor_photos_ready(p_vendor_id, p_vendor_phone);\n'
    || E'  END IF;';
  v_gate_crlf := replace(v_gate, E'\n', E'\r\n');
  v_identity := E'  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '''' THEN';

  IF p_enabled THEN
    IF position('_assert_vendor_not_banned' IN def) > 0 THEN
      RETURN 'already_enabled';
    END IF;
    IF position(v_identity IN def) = 0 THEN
      RAISE EXCEPTION 'failed to inject ban gate into vendor_update_own';
    END IF;
    def := replace(def, v_identity, v_gate || E'\n\n' || v_identity);
    IF position('_assert_vendor_not_banned' IN def) = 0 THEN
      RAISE EXCEPTION 'failed to inject ban gate into vendor_update_own';
    END IF;
    IF position('_assert_vendor_session_matches' IN def) = 0 THEN
      RAISE EXCEPTION 'refusing to rewrite vendor_update_own: session-hybrid gate missing';
    END IF;
    EXECUTE def;
    RETURN 'enabled';
  ELSE
    IF position('_assert_vendor_not_banned' IN def) = 0 THEN
      RETURN 'already_disabled';
    END IF;

    v_stripped := replace(def, v_gate || E'\n\n', '');
    IF v_stripped = def THEN
      v_stripped := replace(def, v_gate || E'\n', '');
    END IF;
    IF v_stripped = def THEN
      v_stripped := replace(def, v_gate_crlf || E'\r\n\r\n', '');
    END IF;
    IF v_stripped = def THEN
      v_stripped := regexp_replace(
        def,
        E'[ \\t]*IF p_patch \\? ''is_active'' AND \\(p_patch->>''is_active''\\)::boolean IS TRUE THEN\\r?\\n'
        || E'[ \\t]*PERFORM public\\._assert_vendor_not_banned\\(p_vendor_id, p_vendor_phone\\);\\r?\\n'
        || E'[ \\t]*PERFORM public\\._assert_vendor_photos_ready\\(p_vendor_id, p_vendor_phone\\);\\r?\\n'
        || E'[ \\t]*END IF;\\r?\\n(?:\\r?\\n)?',
        '',
        'g'
      );
    END IF;

    IF position('_assert_vendor_not_banned' IN v_stripped) > 0 THEN
      RAISE EXCEPTION 'failed to strip ban gate from vendor_update_own';
    END IF;
    IF position('_assert_vendor_session_matches' IN v_stripped) = 0 THEN
      RAISE EXCEPTION 'refusing to rewrite vendor_update_own: session-hybrid gate missing';
    END IF;
    EXECUTE v_stripped;
    RETURN 'disabled';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._test_set_vendor_update_own_ban_assert(boolean) IS
  'TEST-only: toggle the ban+photos go-live guard inside vendor_update_own for A/B regression proof. Strips/restores the is_active IF block only; does not move the session-hybrid PERFORM. service_role only.';

REVOKE ALL ON FUNCTION public._test_set_vendor_update_own_ban_assert(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._test_set_vendor_update_own_ban_assert(boolean) TO service_role;
