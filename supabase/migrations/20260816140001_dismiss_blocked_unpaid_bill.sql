-- Block customer/vendor dismiss while an unpaid cash/UPI bill is still open.
-- Khata unpaid is tracked on the ledger (existing settle-dues UI); add_bill_to_khata
-- clears the cash/UPI orphan path by flipping payment_mode to khata.

CREATE OR REPLACE FUNCTION public.dismiss_order(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL,
  p_appointment_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_bills ob
    WHERE ob.request_id = p_request_id
      AND ob.payment_status = 'unpaid'
      AND lower(btrim(coalesce(ob.payment_mode, ''))) IN ('cash', 'upi', '')
  ) THEN
    RAISE EXCEPTION 'dismiss_blocked_unpaid_bill';
  END IF;

  UPDATE public.requests
  SET
    status = 'done',
    appointment_status = COALESCE(p_appointment_status, appointment_status)
  WHERE id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR
      (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.dismiss_order(uuid, text, text, text) IS
  'Customer dismisses their own order (marks done). Rejects while unpaid cash/UPI bill exists.';

CREATE OR REPLACE FUNCTION public.vendor_dismiss_requests(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_bills ob
    JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.request_id = ANY (p_request_ids)
      AND r.vendor_id = p_vendor_id
      AND ob.payment_status = 'unpaid'
      AND lower(btrim(coalesce(ob.payment_mode, ''))) IN ('cash', 'upi', '')
  ) THEN
    RAISE EXCEPTION 'dismiss_blocked_unpaid_bill';
  END IF;

  UPDATE public.requests r
  SET status = 'done'
  FROM public.vendors v
  WHERE r.id = ANY (p_request_ids)
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

COMMENT ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) IS
  'Vendor dismisses requests to done. Rejects while any target has unpaid cash/UPI bill.';

REVOKE ALL ON FUNCTION public.dismiss_order(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_order(uuid, text, text, text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) TO anon, authenticated, service_role;
