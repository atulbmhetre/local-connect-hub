-- Harden order lifecycle from-status gates (Critical gaps from state-machine review).
-- 1) vendor_accept_order: only sent|seen may become accepted (ignore forged p_from_status).
-- 2) vendor_settle_order: only accepted may become fulfilled.
-- vendor_fulfill_order remains dropped (20260905130001); settle is the live path.

CREATE OR REPLACE FUNCTION public.vendor_accept_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_from_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
  v_from text;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  v_from := lower(btrim(COALESCE(p_from_status, '')));
  IF v_from IS DISTINCT FROM 'sent' AND v_from IS DISTINCT FROM 'seen' THEN
    RAISE EXCEPTION 'invalid_from_status';
  END IF;

  UPDATE public.requests r
  SET status = 'accepted'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND r.status IN ('sent', 'seen')
    AND r.status = v_from
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

COMMENT ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text) IS
  'Accept order only from sent|seen. Rejects forged p_from_status (invalid_from_status). Soft hybrid + ban assert.';

REVOKE ALL ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.vendor_settle_order(
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
    AND r.status = 'accepted'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.requests r
      JOIN public.vendors v ON v.id = r.vendor_id
      WHERE r.id = p_request_id
        AND r.vendor_id = p_vendor_id
        AND v.phone = p_vendor_phone
        AND r.status IS DISTINCT FROM 'accepted'
    ) THEN
      RAISE EXCEPTION 'not_accepted';
    END IF;
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_settle_order(uuid, uuid, text) IS
  'Mark request fulfilled only when current status is accepted. Soft hybrid session check.';

REVOKE ALL ON FUNCTION public.vendor_settle_order(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_settle_order(uuid, uuid, text)
  TO anon, authenticated, service_role;
