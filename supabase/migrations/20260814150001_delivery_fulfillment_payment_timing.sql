-- Phase 0: delivery fulfillment method (vendor vs agent) + prepaid/postpaid per business.
-- Snapshots onto delivery requests at order creation; bill send can override request snapshot.

-- ── Schema ───────────────────────────────────────────────────────────────────

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS delivery_fulfillment_method text NOT NULL DEFAULT 'vendor',
  ADD COLUMN IF NOT EXISTS delivery_payment_timing text NOT NULL DEFAULT 'postpaid';

ALTER TABLE public.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_delivery_fulfillment_method_chk;

ALTER TABLE public.vendor_categories
  ADD CONSTRAINT vendor_categories_delivery_fulfillment_method_chk
  CHECK (delivery_fulfillment_method IN ('vendor', 'agent'));

ALTER TABLE public.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_delivery_payment_timing_chk;

ALTER TABLE public.vendor_categories
  ADD CONSTRAINT vendor_categories_delivery_payment_timing_chk
  CHECK (delivery_payment_timing IN ('prepaid', 'postpaid'));

COMMENT ON COLUMN public.vendor_categories.delivery_fulfillment_method IS
  'Delivery fulfillment: vendor delivers personally, or uses a delivery agent.';
COMMENT ON COLUMN public.vendor_categories.delivery_payment_timing IS
  'When customer pays for agent-fulfilled delivery: prepaid or postpaid. Ignored when fulfillment is vendor.';

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS delivery_fulfillment_method text,
  ADD COLUMN IF NOT EXISTS delivery_payment_timing text;

ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_delivery_fulfillment_method_chk;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_delivery_fulfillment_method_chk
  CHECK (
    delivery_fulfillment_method IS NULL
    OR delivery_fulfillment_method IN ('vendor', 'agent')
  );

ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_delivery_payment_timing_chk;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_delivery_payment_timing_chk
  CHECK (
    delivery_payment_timing IS NULL
    OR delivery_payment_timing IN ('prepaid', 'postpaid')
  );

COMMENT ON COLUMN public.requests.delivery_fulfillment_method IS
  'Snapshot from vendor_categories at order creation (delivery orders only). Bill send may override.';
COMMENT ON COLUMN public.requests.delivery_payment_timing IS
  'Snapshot from vendor_categories at order creation (delivery orders only). Bill send may override.';

-- ── create_customer_request: snapshot delivery settings on delivery orders ─────

DROP FUNCTION IF EXISTS public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
);

CREATE OR REPLACE FUNCTION public.create_customer_request(
  p_device_id text,
  p_vendor_id uuid,
  p_message text,
  p_user_phone text DEFAULT NULL,
  p_device_id_log text DEFAULT NULL,
  p_delivery_address text DEFAULT NULL,
  p_delivery_slot text DEFAULT NULL,
  p_delivery_slot_deadline timestamptz DEFAULT NULL,
  p_appointment_time timestamptz DEFAULT NULL,
  p_appointment_status text DEFAULT NULL,
  p_customer_latitude double precision DEFAULT NULL,
  p_customer_longitude double precision DEFAULT NULL,
  p_appointment_instant boolean DEFAULT false,
  p_category_id uuid DEFAULT NULL,
  p_service_mode text DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_service_location text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_vendor_active boolean;
  v_vendor_banned boolean;
  v_vendor_discoverable boolean;
  v_vendor_profile_status text;
  v_customer_banned boolean;
  v_category_id uuid;
  v_service_mode text;
  v_category_modes text[];
  v_service_location text;
  v_delivery_fulfillment_method text;
  v_delivery_payment_timing text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    SELECT COALESCE(u.is_banned, false)
    INTO v_customer_banned
    FROM public.users u
    WHERE u.phone = btrim(p_user_phone)
    LIMIT 1;

    IF COALESCE(v_customer_banned, false) THEN
      RAISE EXCEPTION 'customer_banned';
    END IF;
  END IF;

  SELECT
    COALESCE(v.is_active, false),
    COALESCE(v.is_banned, false),
    COALESCE(v.discoverable, false),
    v.profile_status
  INTO v_vendor_active, v_vendor_banned, v_vendor_discoverable, v_vendor_profile_status
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF v_vendor_banned THEN
    RAISE EXCEPTION 'vendor_banned';
  END IF;

  IF NOT v_vendor_discoverable THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;

  SELECT category_id, service_mode
  INTO v_category_id, v_service_mode
  FROM public._resolve_booking_category(
    p_vendor_id,
    p_category_id,
    p_service_mode,
    p_delivery_slot,
    p_appointment_time
  );

  SELECT COALESCE(array_agg(vcm.mode), ARRAY[]::text[])
  INTO v_category_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id AND vc.category_id = v_category_id;

  IF v_category_modes IS NOT NULL AND array_length(v_category_modes, 1) > 0 AND NOT (v_service_mode = ANY(v_category_modes)) THEN
    RAISE EXCEPTION 'service_mode_unavailable';
  END IF;

  v_service_location := NULLIF(btrim(p_service_location), '');
  IF v_service_location IS NOT NULL AND v_service_location NOT IN ('customer_place', 'vendor_place') THEN
    RAISE EXCEPTION 'invalid_service_location';
  END IF;

  v_delivery_fulfillment_method := NULL;
  v_delivery_payment_timing := NULL;
  IF v_service_mode = 'delivery' THEN
    SELECT
      vc.delivery_fulfillment_method,
      vc.delivery_payment_timing
    INTO v_delivery_fulfillment_method, v_delivery_payment_timing
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = v_category_id
    LIMIT 1;

    v_delivery_fulfillment_method := COALESCE(v_delivery_fulfillment_method, 'vendor');
    v_delivery_payment_timing := COALESCE(v_delivery_payment_timing, 'postpaid');
    IF v_delivery_fulfillment_method = 'vendor' THEN
      v_delivery_payment_timing := 'postpaid';
    END IF;
  END IF;

  INSERT INTO public.requests (
    device_id,
    vendor_id,
    message,
    user_phone,
    delivery_address,
    delivery_slot,
    delivery_slot_deadline,
    appointment_time,
    appointment_status,
    customer_latitude,
    customer_longitude,
    category_id,
    service_mode,
    items,
    service_location,
    delivery_fulfillment_method,
    delivery_payment_timing
  )
  VALUES (
    p_device_id,
    p_vendor_id,
    p_message,
    p_user_phone,
    p_delivery_address,
    p_delivery_slot,
    p_delivery_slot_deadline,
    p_appointment_time,
    p_appointment_status,
    p_customer_latitude,
    p_customer_longitude,
    v_category_id,
    v_service_mode,
    p_items,
    v_service_location,
    v_delivery_fulfillment_method,
    v_delivery_payment_timing
  )
  RETURNING id INTO v_id;

  IF NOT v_vendor_active THEN
    NULL;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.create_customer_request(
  text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, text, double precision, double precision,
  boolean, uuid, text, jsonb, text
) IS
  'Customer order/booking insert. Snapshots delivery fulfillment/timing from vendor_categories for delivery orders.';

-- ── vendor_update_categories: persist per-business delivery settings ─────────

DROP FUNCTION IF EXISTS public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
);

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[],
  p_category_modes jsonb,
  p_brand_names text[] DEFAULT NULL,
  p_serves_at_vendor_place boolean[] DEFAULT NULL,
  p_serves_at_customer_place boolean[] DEFAULT NULL,
  p_service_radius_km numeric[] DEFAULT NULL,
  p_delivery_fulfillment_methods text[] DEFAULT NULL,
  p_delivery_payment_timings text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cat_count integer;
  v_needs_review boolean;
  i integer;
  v_old_ids uuid[];
  v_removed uuid[];
  v_added uuid[];
  v_shop_name text;
  v_new_id uuid;
  v_acct_brand text;
  v_acct_vendor_place boolean;
  v_acct_customer_place boolean;
  v_acct_radius numeric;
  v_brand text;
  v_vendor_place boolean;
  v_customer_place boolean;
  v_radius numeric;
  v_vc_id uuid;
  v_modes text[];
  v_catalog_mode text;
  v_cat_primary text;
  v_delivery_fulfillment text;
  v_delivery_payment text;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  PERFORM 1
  FROM public.vendors
  WHERE id = p_vendor_id
    AND phone = trim(p_vendor_phone)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);
  IF v_cat_count = 0 THEN
    RAISE EXCEPTION 'category_ids_required';
  END IF;

  IF cardinality(p_category_ids)
     <> (SELECT count(DISTINCT x) FROM unnest(p_category_ids) AS x)
  THEN
    RAISE EXCEPTION 'duplicate_category_ids';
  END IF;

  IF p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  IF p_brand_names IS NOT NULL
    AND COALESCE(array_length(p_brand_names, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'brand_names length must match category_ids length';
  END IF;
  IF p_serves_at_vendor_place IS NOT NULL
    AND COALESCE(array_length(p_serves_at_vendor_place, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'serves_at_vendor_place length must match category_ids length';
  END IF;
  IF p_serves_at_customer_place IS NOT NULL
    AND COALESCE(array_length(p_serves_at_customer_place, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'serves_at_customer_place length must match category_ids length';
  END IF;
  IF p_service_radius_km IS NOT NULL
    AND COALESCE(array_length(p_service_radius_km, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'service_radius_km length must match category_ids length';
  END IF;
  IF p_delivery_fulfillment_methods IS NOT NULL
    AND COALESCE(array_length(p_delivery_fulfillment_methods, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'delivery_fulfillment_methods length must match category_ids length';
  END IF;
  IF p_delivery_payment_timings IS NOT NULL
    AND COALESCE(array_length(p_delivery_payment_timings, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'delivery_payment_timings length must match category_ids length';
  END IF;

  PERFORM public._assert_category_modes_map(p_category_ids, p_category_modes);

  SELECT COALESCE(array_agg(vc.category_id), ARRAY[]::uuid[])
  INTO v_old_ids
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id;

  SELECT COALESCE(array_agg(old_id), ARRAY[]::uuid[])
  INTO v_removed
  FROM unnest(v_old_ids) AS old_id
  WHERE NOT (old_id = ANY (p_category_ids));

  SELECT COALESCE(array_agg(new_id), ARRAY[]::uuid[])
  INTO v_added
  FROM unnest(p_category_ids) AS new_id
  WHERE NOT (new_id = ANY (v_old_ids));

  SELECT
    v.shop_name,
    COALESCE(v.serves_at_vendor_place, false),
    COALESCE(v.serves_at_customer_place, true),
    v.service_radius_km
  INTO v_shop_name, v_acct_vendor_place, v_acct_customer_place, v_acct_radius
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  v_acct_brand := NULLIF(trim(COALESCE(v_shop_name, '')), '');
  v_needs_review := v_cat_count >= 3;

  FOR i IN 1..v_cat_count LOOP
    v_brand := CASE
      WHEN p_brand_names IS NOT NULL THEN NULLIF(trim(p_brand_names[i]), '')
      ELSE NULL
    END;
    v_vendor_place := CASE
      WHEN p_serves_at_vendor_place IS NOT NULL THEN p_serves_at_vendor_place[i]
      ELSE NULL
    END;
    v_customer_place := CASE
      WHEN p_serves_at_customer_place IS NOT NULL THEN p_serves_at_customer_place[i]
      ELSE NULL
    END;
    v_radius := CASE
      WHEN p_service_radius_km IS NOT NULL THEN p_service_radius_km[i]
      ELSE NULL
    END;
    v_delivery_fulfillment := CASE
      WHEN p_delivery_fulfillment_methods IS NOT NULL THEN NULLIF(trim(p_delivery_fulfillment_methods[i]), '')
      ELSE NULL
    END;
    v_delivery_payment := CASE
      WHEN p_delivery_payment_timings IS NOT NULL THEN NULLIF(trim(p_delivery_payment_timings[i]), '')
      ELSE NULL
    END;

    v_brand := COALESCE(v_brand, v_acct_brand);
    v_vendor_place := COALESCE(v_vendor_place, v_acct_vendor_place);
    v_customer_place := COALESCE(v_customer_place, v_acct_customer_place);
    v_radius := COALESCE(v_radius, v_acct_radius);
    v_delivery_fulfillment := COALESCE(v_delivery_fulfillment, 'vendor');
    v_delivery_payment := COALESCE(v_delivery_payment, 'postpaid');

    IF v_delivery_fulfillment NOT IN ('vendor', 'agent') THEN
      RAISE EXCEPTION 'invalid_delivery_fulfillment_method';
    END IF;
    IF v_delivery_payment NOT IN ('prepaid', 'postpaid') THEN
      RAISE EXCEPTION 'invalid_delivery_payment_timing';
    END IF;
    IF v_delivery_fulfillment = 'vendor' THEN
      v_delivery_payment := 'postpaid';
    END IF;

    IF NOT COALESCE(v_vendor_place, false) AND NOT COALESCE(v_customer_place, false) THEN
      RAISE EXCEPTION 'category_reach_required';
    END IF;

    SELECT c.service_mode INTO v_catalog_mode
    FROM public.categories c
    WHERE c.id = p_category_ids[i];

    v_modes := public._modes_from_category_map(p_category_ids[i], p_category_modes);
    v_cat_primary := public._pick_primary_availability_mode(
      v_modes,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), v_catalog_mode)
    );

    SELECT vc.id
    INTO v_vc_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_ids[i]
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.vendor_categories
      SET
        is_primary = (i = 1),
        needs_review = v_needs_review,
        brand_name = v_brand,
        serves_at_vendor_place = v_vendor_place,
        serves_at_customer_place = v_customer_place,
        service_radius_km = v_radius,
        delivery_fulfillment_method = v_delivery_fulfillment,
        delivery_payment_timing = v_delivery_payment
      WHERE id = v_vc_id;
    ELSE
      INSERT INTO public.vendor_categories (
        vendor_id,
        category_id,
        is_primary,
        status,
        needs_review,
        service_mode,
        brand_name,
        serves_at_vendor_place,
        serves_at_customer_place,
        service_radius_km,
        delivery_fulfillment_method,
        delivery_payment_timing
      )
      VALUES (
        p_vendor_id,
        p_category_ids[i],
        i = 1,
        'approved',
        v_needs_review,
        v_cat_primary,
        v_brand,
        v_vendor_place,
        v_customer_place,
        v_radius,
        v_delivery_fulfillment,
        v_delivery_payment
      )
      RETURNING id INTO v_vc_id;
    END IF;

    PERFORM public._rewrite_vendor_category_modes(v_vc_id, v_modes, v_catalog_mode);
  END LOOP;

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id
    AND NOT (category_id = ANY (p_category_ids));

  IF COALESCE(array_length(v_removed, 1), 0) > 0 THEN
    PERFORM public._purge_saved_vendors_for_removed_categories(
      p_vendor_id,
      v_removed,
      v_shop_name
    );

    DELETE FROM public.vendor_category_cancel_reasons
    WHERE vendor_id = p_vendor_id
      AND category_id = ANY (v_removed);
  END IF;

  IF COALESCE(array_length(v_added, 1), 0) > 0 THEN
    FOREACH v_new_id IN ARRAY v_added
    LOOP
      PERFORM public._copy_account_cancel_reasons_to_category(p_vendor_id, v_new_id);
    END LOOP;
  END IF;

  PERFORM public._derive_vendor_availability_modes(p_vendor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[], text[], text[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[], text[], text[]
) TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[], text[], text[]
) IS
  'Reconcile vendor categories in place. Includes per-business delivery fulfillment and payment timing.';

-- ── vendor_update_profile_and_categories: pass delivery arrays through ───────

DROP FUNCTION IF EXISTS public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[]
);

CREATE OR REPLACE FUNCTION public.vendor_update_profile_and_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_patch jsonb,
  p_category_ids uuid[],
  p_category_service_modes text[],
  p_category_modes jsonb,
  p_brand_names text[] DEFAULT NULL,
  p_serves_at_vendor_place boolean[] DEFAULT NULL,
  p_serves_at_customer_place boolean[] DEFAULT NULL,
  p_service_radius_km numeric[] DEFAULT NULL,
  p_delivery_fulfillment_methods text[] DEFAULT NULL,
  p_delivery_payment_timings text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.vendor_update_own(p_vendor_id, p_vendor_phone, p_patch);
  PERFORM public.vendor_update_categories(
    p_vendor_id,
    COALESCE(NULLIF(trim(p_patch->>'phone'), ''), trim(p_vendor_phone)),
    p_category_ids,
    p_category_service_modes,
    p_category_modes,
    p_brand_names,
    p_serves_at_vendor_place,
    p_serves_at_customer_place,
    p_service_radius_km,
    p_delivery_fulfillment_methods,
    p_delivery_payment_timings
  );
END;
$$;

COMMENT ON FUNCTION public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[], text[], text[]
) IS
  'Atomic Edit Shop Details: vendor_update_own + vendor_update_categories in one transaction.';

REVOKE ALL ON FUNCTION public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[], text[], text[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.vendor_update_profile_and_categories(
  uuid, text, jsonb, uuid[], text[], jsonb, text[], boolean[], boolean[], numeric[], text[], text[]
) TO anon, authenticated, service_role;

-- ── insert_bill_with_items: optional per-order delivery snapshot override ────

DROP FUNCTION IF EXISTS public.insert_bill_with_items(uuid, uuid, text, numeric, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.insert_bill_with_items(
  p_order_id uuid,
  p_vendor_id uuid,
  p_customer_phone text,
  p_total numeric,
  p_payment_mode text,
  p_payment_status text DEFAULT 'unpaid',
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_delivery_fulfillment_method text DEFAULT NULL,
  p_delivery_payment_timing text DEFAULT NULL
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
  v_phone text;
  v_void_bill record;
  v_outstanding numeric;
  v_khata_note text;
  v_red_limit numeric;
  v_fulfillment text;
  v_payment_timing text;
BEGIN
  v_phone := NULLIF(TRIM(p_customer_phone), '');

  IF p_delivery_fulfillment_method IS NOT NULL THEN
    v_fulfillment := NULLIF(btrim(p_delivery_fulfillment_method), '');
    IF v_fulfillment IS NOT NULL AND v_fulfillment NOT IN ('vendor', 'agent') THEN
      RAISE EXCEPTION 'invalid_delivery_fulfillment_method';
    END IF;
    v_payment_timing := NULLIF(btrim(COALESCE(p_delivery_payment_timing, '')), '');
    IF v_fulfillment = 'vendor' THEN
      v_payment_timing := 'postpaid';
    ELSIF v_payment_timing IS NULL THEN
      v_payment_timing := 'postpaid';
    ELSIF v_payment_timing NOT IN ('prepaid', 'postpaid') THEN
      RAISE EXCEPTION 'invalid_delivery_payment_timing';
    END IF;

    UPDATE public.requests r
    SET
      delivery_fulfillment_method = v_fulfillment,
      delivery_payment_timing = v_payment_timing
    WHERE r.id = p_order_id
      AND r.vendor_id = p_vendor_id
      AND r.service_mode = 'delivery'
      AND v_fulfillment IS NOT NULL;
  END IF;

  SELECT
    ob.id,
    ob.vendor_id,
    ob.user_phone,
    ob.total_amount,
    ob.payment_mode
  INTO v_void_bill
  FROM public.order_bills ob
  WHERE ob.request_id = p_order_id
    AND ob.payment_status = 'void'
  LIMIT 1;

  IF FOUND THEN
    IF v_void_bill.payment_mode = 'khata' AND v_void_bill.user_phone IS NOT NULL THEN
      INSERT INTO public.khata_transactions (
        vendor_id,
        user_phone,
        amount,
        note,
        payment_mode,
        request_id
      )
      VALUES (
        v_void_bill.vendor_id,
        v_void_bill.user_phone,
        -v_void_bill.total_amount,
        'Bill voided',
        'khata',
        p_order_id
      );

      SELECT kl.total_outstanding
      INTO v_outstanding
      FROM public.khata_ledger kl
      WHERE kl.vendor_id = v_void_bill.vendor_id
        AND kl.user_phone = v_void_bill.user_phone;

      IF FOUND THEN
        UPDATE public.khata_ledger
        SET
          total_outstanding = GREATEST(0, v_outstanding - v_void_bill.total_amount),
          last_updated = now()
        WHERE vendor_id = v_void_bill.vendor_id
          AND user_phone = v_void_bill.user_phone;
      END IF;
    END IF;

    DELETE FROM public.order_bills
    WHERE id = v_void_bill.id;
  END IF;

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
    v_phone,
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

  IF p_payment_mode = 'khata' AND v_phone IS NOT NULL THEN
    SELECT v.khata_red_limit
    INTO v_red_limit
    FROM public.vendors v
    WHERE v.id = p_vendor_id;

    IF v_red_limit IS NOT NULL AND v_red_limit > 0 THEN
      INSERT INTO public.khata_ledger (
        vendor_id,
        user_phone,
        total_outstanding,
        last_updated
      )
      VALUES (
        p_vendor_id,
        v_phone,
        0,
        now()
      )
      ON CONFLICT (vendor_id, user_phone) DO NOTHING;

      SELECT kl.total_outstanding
      INTO v_outstanding
      FROM public.khata_ledger kl
      WHERE kl.vendor_id = p_vendor_id
        AND kl.user_phone = v_phone
      FOR UPDATE;

      IF COALESCE(v_outstanding, 0) >= v_red_limit THEN
        RAISE EXCEPTION 'khata_red_limit_exceeded';
      END IF;
    END IF;

    v_khata_note := COALESCE(NULLIF(TRIM(p_notes), ''), 'Bill from order');

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
      v_phone,
      p_total,
      v_khata_note,
      'khata',
      p_order_id
    );

    INSERT INTO public.khata_ledger (
      vendor_id,
      user_phone,
      total_outstanding,
      last_updated
    )
    VALUES (
      p_vendor_id,
      v_phone,
      p_total,
      now()
    )
    ON CONFLICT (vendor_id, user_phone)
    DO UPDATE SET
      total_outstanding = public.khata_ledger.total_outstanding + EXCLUDED.total_outstanding,
      last_updated = now();
  END IF;

  RETURN v_bill_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_bill_with_items(
  uuid, uuid, text, numeric, text, text, text, jsonb, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.insert_bill_with_items(
  uuid, uuid, text, numeric, text, text, text, jsonb, text, text
) TO anon, authenticated;
