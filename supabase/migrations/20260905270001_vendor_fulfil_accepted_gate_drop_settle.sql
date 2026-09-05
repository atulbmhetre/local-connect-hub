-- Correct live fulfil gate: vendor_fulfil_order (IncomingOrdersSection).
-- Drop mistaken vendor_settle_order from 20260905260001 (never called by app).

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

COMMENT ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text) IS
  'Mark request fulfilled only when current status is accepted. Soft hybrid session check.';

REVOKE ALL ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text)
  TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.vendor_settle_order(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.vendor_settle_order(uuid, uuid, text);
