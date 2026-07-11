-- When a khata payment zeroes the ledger, mark unpaid khata order_bills paid in the
-- same transaction as vendor_record_khata_payment (same FOR UPDATE lock on ledger).
-- vendor_mark_customer_khata_bills_paid is unchanged for direct/legacy callers.

CREATE OR REPLACE FUNCTION public.vendor_record_khata_payment(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_customer_phone text,
  p_amount numeric,
  p_note text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_phone text;
  v_current_outstanding numeric;
  v_new_outstanding numeric;
BEGIN
  v_customer_phone := NULLIF(TRIM(p_customer_phone), '');
  IF v_customer_phone IS NULL THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'vendor_not_found_or_unauthorized';
  END IF;

  SELECT kl.total_outstanding
  INTO v_current_outstanding
  FROM public.khata_ledger kl
  WHERE kl.vendor_id = p_vendor_id
    AND kl.user_phone = v_customer_phone
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found';
  END IF;

  IF v_current_outstanding <= 0 THEN
    RAISE EXCEPTION 'no_outstanding_balance';
  END IF;

  IF p_amount > v_current_outstanding THEN
    RAISE EXCEPTION 'amount_exceeds_outstanding';
  END IF;

  INSERT INTO public.khata_transactions (
    vendor_id,
    user_phone,
    amount,
    note,
    payment_mode,
    created_at
  )
  VALUES (
    p_vendor_id,
    v_customer_phone,
    p_amount,
    NULLIF(TRIM(p_note), ''),
    'paid',
    now()
  );

  v_new_outstanding := GREATEST(0, v_current_outstanding - p_amount);

  UPDATE public.khata_ledger kl
  SET
    total_outstanding = v_new_outstanding,
    last_updated = now()
  WHERE kl.vendor_id = p_vendor_id
    AND kl.user_phone = v_customer_phone;

  IF v_new_outstanding = 0 THEN
    UPDATE public.order_bills ob
    SET payment_status = 'paid', paid_at = now()
    WHERE ob.vendor_id = p_vendor_id
      AND ob.user_phone = v_customer_phone
      AND ob.payment_mode = 'khata'
      AND ob.payment_status = 'unpaid';
  END IF;

  RETURN v_new_outstanding;
END;
$$;

COMMENT ON FUNCTION public.vendor_record_khata_payment(uuid, text, text, numeric, text) IS
  'Vendor records khata payment; rejects when ledger has no positive outstanding balance. When balance reaches zero, marks unpaid khata order_bills paid in the same transaction.';

REVOKE ALL ON FUNCTION public.vendor_record_khata_payment(uuid, text, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_record_khata_payment(uuid, text, text, numeric, text) TO anon, authenticated;
