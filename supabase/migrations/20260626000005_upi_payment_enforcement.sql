-- UPI payment enforcement: require a bill before fulfilment; vendor confirms claimed UPI payment.

-- Part 1 — Block status → fulfilled unless an order_bills row exists for the request.
CREATE OR REPLACE FUNCTION public.check_bill_before_fulfil()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'fulfilled' AND OLD.status != 'fulfilled' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.order_bills WHERE request_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'cannot_fulfil_without_bill';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_bill_before_fulfil() IS
  'BEFORE UPDATE on requests: rejects fulfilment when no order_bills row exists for the request.';

DROP TRIGGER IF EXISTS trg_check_bill_before_fulfil ON public.requests;
CREATE TRIGGER trg_check_bill_before_fulfil
  BEFORE UPDATE ON public.requests
  FOR EACH ROW
  EXECUTE FUNCTION public.check_bill_before_fulfil();

-- Part 2 — Vendor confirms customer UPI payment claim; marks request and bill paid.
CREATE OR REPLACE FUNCTION public.confirm_upi_payment(
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
  SET
    payment_status = 'confirmed',
    payment_confirmed_at = now()
  WHERE id = p_request_id;

  UPDATE public.order_bills
  SET
    payment_status = 'paid',
    paid_at = now()
  WHERE request_id = p_request_id;
END;
$$;

COMMENT ON FUNCTION public.confirm_upi_payment(uuid) IS
  'Vendor confirms a claimed UPI payment (session via auth_user_phone): sets requests.payment_status to confirmed and order_bills to paid.';

REVOKE ALL ON FUNCTION public.confirm_upi_payment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_upi_payment(uuid) TO anon, authenticated;
