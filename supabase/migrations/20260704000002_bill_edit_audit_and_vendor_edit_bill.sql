-- Bill edit audit trail + vendor_edit_bill RPC (items/qty/price only; khata corrections append-only).

CREATE TABLE public.bill_edit_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.order_bills (id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  vendor_phone text NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  old_items_snapshot jsonb NOT NULL,
  new_items_snapshot jsonb NOT NULL,
  old_total numeric NOT NULL,
  new_total numeric NOT NULL,
  created_khata_adjustment_id uuid REFERENCES public.khata_transactions (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.bill_edit_audit IS
  'Immutable audit log for vendor bill line-item edits. Writes via vendor_edit_bill only.';

CREATE INDEX bill_edit_audit_bill_id_edited_at_idx
  ON public.bill_edit_audit (bill_id, edited_at DESC);

ALTER TABLE public.bill_edit_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY bill_edit_audit_vendor_select ON public.bill_edit_audit
  FOR SELECT
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT id FROM public.vendors WHERE phone = public.auth_user_phone()
    )
  );

CREATE OR REPLACE FUNCTION public.vendor_edit_bill(
  p_bill_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_new_items jsonb,
  p_reason text DEFAULT NULL,
  p_confirmed_late_edit boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill record;
  v_bill_age_hours numeric;
  v_is_paid boolean;
  v_is_khata_synced boolean;
  v_affects_khata boolean;
  v_old_total numeric;
  v_new_total numeric := 0;
  v_old_items_snapshot jsonb;
  v_new_items_snapshot jsonb := '[]'::jsonb;
  v_item jsonb;
  v_name text;
  v_qty numeric;
  v_unit_price numeric;
  v_unit text;
  v_line_total numeric;
  v_delta numeric;
  v_khata_note text;
  v_khata_adjustment_id uuid;
  v_audit_id uuid;
  v_updated_bill jsonb;
  v_items_json jsonb;
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
    ob.request_id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode,
    ob.payment_status,
    ob.created_at
  INTO v_bill
  FROM public.order_bills ob
  WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found';
  END IF;

  IF v_bill.payment_status = 'void' THEN
    RAISE EXCEPTION 'bill_void';
  END IF;

  v_bill_age_hours := EXTRACT(EPOCH FROM (now() - v_bill.created_at)) / 3600.0;

  v_is_paid := v_bill.payment_status = 'paid';
  v_is_khata_synced := v_bill.payment_mode = 'khata';
  v_affects_khata := v_is_khata_synced;

  IF v_bill_age_hours > 24
     AND (v_is_paid OR v_is_khata_synced)
     AND NOT p_confirmed_late_edit THEN
    RAISE EXCEPTION 'late_edit_confirmation_required';
  END IF;

  IF (v_is_paid OR v_is_khata_synced)
     AND NULLIF(TRIM(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  v_old_total := v_bill.total_amount;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'description', oi.description,
        'quantity', oi.quantity,
        'unit', oi.unit,
        'unit_price', oi.unit_price,
        'total_price', oi.total_price
      )
      ORDER BY oi.created_at, oi.id
    ),
    '[]'::jsonb
  )
  INTO v_old_items_snapshot
  FROM public.order_items oi
  WHERE oi.request_id = v_bill.request_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_items, '[]'::jsonb))
  LOOP
    v_name := v_item->>'name';
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price', '')::numeric, 0);
    v_unit := NULLIF(TRIM(COALESCE(v_item->>'unit', '')), '');

    IF v_name IS NOT NULL AND TRIM(v_name) <> '' AND v_unit_price > 0 THEN
      v_qty := GREATEST(v_qty, 1);
      v_line_total := v_qty * v_unit_price;
      v_new_total := v_new_total + v_line_total;

      v_new_items_snapshot := v_new_items_snapshot || jsonb_build_array(
        jsonb_build_object(
          'description', TRIM(v_name),
          'quantity', v_qty,
          'unit', v_unit,
          'unit_price', v_unit_price,
          'total_price', v_line_total
        )
      );
    END IF;
  END LOOP;

  IF jsonb_array_length(v_new_items_snapshot) = 0 THEN
    RAISE EXCEPTION 'items_required';
  END IF;

  DELETE FROM public.order_items
  WHERE request_id = v_bill.request_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_new_items_snapshot)
  LOOP
    INSERT INTO public.order_items (
      request_id,
      description,
      quantity,
      unit,
      unit_price
    )
    VALUES (
      v_bill.request_id,
      v_item->>'description',
      (v_item->>'quantity')::numeric,
      NULLIF(v_item->>'unit', ''),
      (v_item->>'unit_price')::numeric
    );
  END LOOP;

  UPDATE public.order_bills
  SET total_amount = v_new_total
  WHERE id = p_bill_id;

  v_khata_adjustment_id := NULL;

  IF v_affects_khata
     AND v_bill.user_phone IS NOT NULL
     AND v_new_total <> v_old_total THEN
    v_delta := v_new_total - v_old_total;
    v_khata_note := 'Bill edit correction';
    IF NULLIF(TRIM(COALESCE(p_reason, '')), '') IS NOT NULL THEN
      v_khata_note := v_khata_note || ': ' || TRIM(p_reason);
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
      v_delta,
      v_khata_note,
      'khata',
      v_bill.request_id
    )
    RETURNING id INTO v_khata_adjustment_id;

    INSERT INTO public.khata_ledger (
      vendor_id,
      user_phone,
      total_outstanding,
      last_updated
    )
    VALUES (
      p_vendor_id,
      v_bill.user_phone,
      v_delta,
      now()
    )
    ON CONFLICT (vendor_id, user_phone)
    DO UPDATE SET
      total_outstanding = public.khata_ledger.total_outstanding + EXCLUDED.total_outstanding,
      last_updated = now();
  END IF;

  INSERT INTO public.bill_edit_audit (
    bill_id,
    vendor_id,
    vendor_phone,
    reason,
    old_items_snapshot,
    new_items_snapshot,
    old_total,
    new_total,
    created_khata_adjustment_id
  )
  VALUES (
    p_bill_id,
    p_vendor_id,
    p_vendor_phone,
    NULLIF(TRIM(COALESCE(p_reason, '')), ''),
    v_old_items_snapshot,
    v_new_items_snapshot,
    v_old_total,
    v_new_total,
    v_khata_adjustment_id
  )
  RETURNING id INTO v_audit_id;

  SELECT to_jsonb(ob.*)
  INTO v_updated_bill
  FROM public.order_bills ob
  WHERE ob.id = p_bill_id;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(oi.*) ORDER BY oi.created_at, oi.id),
    '[]'::jsonb
  )
  INTO v_items_json
  FROM public.order_items oi
  WHERE oi.request_id = v_bill.request_id;

  RETURN jsonb_build_object(
    'audit_id', v_audit_id,
    'bill', v_updated_bill,
    'items', v_items_json,
    'khata_adjustment_id', v_khata_adjustment_id
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

COMMENT ON FUNCTION public.vendor_edit_bill(uuid, uuid, text, jsonb, text, boolean) IS
  'Vendor edits bill line items with audit trail; khata bills get append-only ledger correction when total changes.';

REVOKE ALL ON FUNCTION public.vendor_edit_bill(uuid, uuid, text, jsonb, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_edit_bill(uuid, uuid, text, jsonb, text, boolean) TO anon, authenticated;
