-- Convert an existing unpaid cash/UPI bill to khata (ledger) after the fact.

CREATE OR REPLACE FUNCTION public.add_bill_to_khata(
  p_bill_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;

  SELECT
    ob.id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode,
    ob.payment_status,
    ob.request_id
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found';
  END IF;

  IF v_bill.payment_status <> 'unpaid' THEN
    RAISE EXCEPTION 'bill_not_unpaid';
  END IF;

  IF v_bill.payment_mode = 'khata' THEN
    RAISE EXCEPTION 'bill_already_khata';
  END IF;

  IF v_bill.user_phone IS NULL THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  INSERT INTO public.khata_transactions (
    vendor_id,
    user_phone,
    amount,
    note,
    payment_mode,
    request_id
  )
  VALUES (
    p_vendor_id,
    v_bill.user_phone,
    v_bill.total_amount,
    'Added to khata',
    'khata',
    v_bill.request_id
  );

  INSERT INTO public.khata_ledger (
    vendor_id,
    user_phone,
    total_outstanding,
    last_updated
  )
  VALUES (
    p_vendor_id,
    v_bill.user_phone,
    v_bill.total_amount,
    now()
  )
  ON CONFLICT (vendor_id, user_phone)
  DO UPDATE SET
    total_outstanding = public.khata_ledger.total_outstanding + EXCLUDED.total_outstanding,
    last_updated = now();

  UPDATE public.order_bills
  SET payment_mode = 'khata'
  WHERE id = p_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.add_bill_to_khata(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_bill_to_khata(uuid, uuid, text) TO anon, authenticated;
