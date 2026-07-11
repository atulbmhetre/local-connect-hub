-- Derive admin_actions.admin_phone from the authenticated session (auth.users),
-- not from the caller-supplied p_admin_phone. Keep p_admin_phone for API compat;
-- use it only if the session lookup returns null.

CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_admin_phone text,
  p_action_type text,
  p_target_type text,
  p_target_id text,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT COALESCE(
    NULLIF(trim(u.email), ''),
    NULLIF(trim(u.phone), '')
  )
  INTO v_label
  FROM auth.users u
  WHERE u.id = auth.uid();

  v_label := COALESCE(
    NULLIF(trim(v_label), ''),
    NULLIF(trim(p_admin_phone), '')
  );

  IF v_label IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.admin_actions (
    admin_phone,
    action_type,
    target_type,
    target_id,
    reason
  )
  VALUES (
    v_label,
    p_action_type,
    p_target_type,
    p_target_id,
    NULLIF(trim(p_notes), '')
  );
END;
$$;

COMMENT ON FUNCTION public.log_admin_action(text, text, text, text, text) IS
  'Inserts an admin_actions audit row. admin_phone is taken from auth.users.email (or phone) for auth.uid(); p_admin_phone is ignored unless that lookup is null.';

REVOKE ALL ON FUNCTION public.log_admin_action(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_admin_action(text, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, text, text) TO authenticated;
