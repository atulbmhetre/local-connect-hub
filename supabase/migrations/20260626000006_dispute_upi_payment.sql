-- Vendor disputes a claimed UPI payment (customer notified via app layer).

CREATE OR REPLACE FUNCTION public.dispute_upi_payment(
  p_request_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id
      AND v.phone = public.auth_user_phone()
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.requests
    WHERE id = p_request_id
      AND payment_status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  UPDATE public.requests
  SET payment_status = 'disputed'
  WHERE id = p_request_id;
END;
$$;

COMMENT ON FUNCTION public.dispute_upi_payment(uuid) IS
  'Vendor disputes a claimed UPI payment: sets requests.payment_status to disputed and customer is notified via app layer.';

REVOKE ALL ON FUNCTION public.dispute_upi_payment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_upi_payment(uuid) TO anon, authenticated;
