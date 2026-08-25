-- Admin override: immediately clear vendors.deletion_requested_at (and the
-- matching users row for that phone), bypassing the 30-day anonymise wait.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Gate/error/grant pattern matches admin_ban_vendor / admin_unban_vendor
-- (is_admin_session, SECURITY DEFINER, authenticated-only EXECUTE).
-- Audit is written inside this RPC (mandatory) so a missed client logAdminAction
-- still leaves an admin_actions row.

CREATE OR REPLACE FUNCTION public.admin_force_clear_deletion(
  p_vendor_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_pending timestamptz;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF NULLIF(trim(p_notes), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  IF p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;

  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT v.phone, v.deletion_requested_at
  INTO v_phone, v_pending
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;

  IF v_pending IS NULL THEN
    RAISE EXCEPTION 'no_deletion_pending';
  END IF;

  UPDATE public.vendors
  SET deletion_requested_at = NULL
  WHERE id = p_vendor_id;

  IF v_phone IS NOT NULL AND trim(v_phone) <> '' THEN
    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = trim(v_phone);
  END IF;

  PERFORM public.log_admin_action(
    NULL,
    'force_clear_deletion',
    'vendor',
    p_vendor_id::text,
    p_notes
  );
END;
$$;

COMMENT ON FUNCTION public.admin_force_clear_deletion(uuid, text) IS
  'Admin session only: null vendors.deletion_requested_at and users.deletion_requested_at for that phone; always writes admin_actions. Reason required.';

REVOKE ALL ON FUNCTION public.admin_force_clear_deletion(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_force_clear_deletion(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_force_clear_deletion(uuid, text) TO authenticated;
