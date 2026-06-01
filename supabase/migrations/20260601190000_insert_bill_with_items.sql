-- Atomic bill + line items insert; allow void status for bill replacement flow.

CREATE OR REPLACE FUNCTION public.insert_bill_with_items(
  p_order_id uuid,
  p_vendor_id uuid,
  p_customer_phone text,
  p_total numeric,
  p_payment_mode text,
  p_payment_status text DEFAULT 'unpaid',
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid;
  v_item jsonb;
  v_name text;
  v_qty numeric;
  v_unit_price numeric;
  v_unit text;
BEGIN
  INSERT INTO public.order_bills (
    request_id,
    vendor_id,
    user_phone,
    total_amount,
    payment_mode,
    payment_status,
    notes
  )
  VALUES (
    p_order_id,
    p_vendor_id,
    NULLIF(TRIM(p_customer_phone), ''),
    p_total,
    p_payment_mode,
    p_payment_status,
    NULLIF(TRIM(p_notes), '')
  )
  RETURNING id INTO v_bill_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_name := v_item->>'name';
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price', '')::numeric, 0);
    v_unit := NULLIF(TRIM(COALESCE(v_item->>'unit', '')), '');

    IF v_name IS NOT NULL AND TRIM(v_name) <> '' AND v_unit_price > 0 THEN
      INSERT INTO public.order_items (
        request_id,
        description,
        quantity,
        unit,
        unit_price
      )
      VALUES (
        p_order_id,
        TRIM(v_name),
        GREATEST(v_qty, 1),
        v_unit,
        v_unit_price
      );
    END IF;
  END LOOP;

  RETURN v_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_bill_with_items(uuid, uuid, text, numeric, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_bill_with_items(uuid, uuid, text, numeric, text, text, text, jsonb) TO anon, authenticated;
