-- Hybrid session assert for two missed live-caller RPCs (TEST first).
-- Same soft hybrid as Session 77: enforce when auth_user_phone() is set;
-- no-op when null (OTP-off unchanged).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public.get_vendor_deletion_status(
  p_phone text
)
RETURNS TABLE (
  vendor_id uuid,
  deletion_requested_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  PERFORM public._assert_vendor_session_matches_phone(p_phone);

  v_phone := NULLIF(btrim(COALESCE(p_phone, '')), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_deletion_status', 'phone', v_phone, 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT v.id, v.deletion_requested_at
  FROM public.vendors v
  WHERE v.phone = v_phone
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_deletion_status(text) IS
  'Vendor existence + deletion_requested_at by phone. Soft hybrid: session phone must match p_phone when Auth is present; OTP-off unchanged.';

REVOKE ALL ON FUNCTION public.get_vendor_deletion_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_deletion_status(text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.vendor_fulfil_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET status = 'fulfilled'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text) IS
  'Mark request fulfilled. Soft hybrid: session must match vendor when Auth is present; OTP-off unchanged.';

REVOKE ALL ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text)
  TO anon, authenticated;
