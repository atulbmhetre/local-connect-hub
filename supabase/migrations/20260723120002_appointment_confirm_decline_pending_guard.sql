-- Guard confirm/decline so only pending appointments can be actioned.
-- Distinct already_actioned when the row exists for this vendor but is no longer pending.

CREATE OR REPLACE FUNCTION public.vendor_confirm_appointment(
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
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET
    appointment_status = 'confirmed',
    status = 'accepted'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND r.appointment_status = 'pending'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id
      AND r.vendor_id = p_vendor_id
      AND v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'already_actioned';
  END IF;

  RAISE EXCEPTION 'not_found_or_unauthorized';
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_decline_booking(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_cancel_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  UPDATE public.requests r
  SET
    appointment_status = 'declined',
    status = 'seen',
    cancel_reason = p_cancel_reason
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND r.appointment_status = 'pending'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id
      AND r.vendor_id = p_vendor_id
      AND v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'already_actioned';
  END IF;

  RAISE EXCEPTION 'not_found_or_unauthorized';
END;
$$;

COMMENT ON FUNCTION public.vendor_confirm_appointment(uuid, uuid, text) IS
  'Confirm pending appointment. Raises already_actioned if not pending; not_found_or_unauthorized if row/vendor mismatch.';

COMMENT ON FUNCTION public.vendor_decline_booking(uuid, uuid, text, text) IS
  'Decline pending appointment. Raises already_actioned if not pending; not_found_or_unauthorized if row/vendor mismatch.';
