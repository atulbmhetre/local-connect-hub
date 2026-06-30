-- Bill-before-fulfil applies to delivery and appointment vendors only.
-- Help-mode orders have no billing step; Mark Done must not require order_bills.

CREATE OR REPLACE FUNCTION public.check_bill_before_fulfil()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_mode text;
BEGIN
  IF NEW.status = 'fulfilled' AND OLD.status IS DISTINCT FROM 'fulfilled' THEN
    SELECT v.service_mode
    INTO v_service_mode
    FROM public.vendors v
    WHERE v.id = NEW.vendor_id;

    IF v_service_mode IN ('delivery', 'appointment') THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.order_bills WHERE request_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'cannot_fulfil_without_bill';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_bill_before_fulfil() IS
  'BEFORE UPDATE on requests: rejects fulfilment for delivery/appointment vendors when no order_bills row exists. Help vendors may fulfil without a bill.';
