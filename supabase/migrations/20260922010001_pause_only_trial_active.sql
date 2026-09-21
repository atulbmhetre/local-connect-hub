-- Pause start allowed only when subscription_status IN ('trial','active').
-- cancelled, grace, expired, and NULL all block. Gate + preflight stay in lockstep.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public._vendor_assert_can_start_pause(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts jsonb;
  v_help integer;
  v_delivery integer;
  v_appointment integer;
  v_sub text;
BEGIN
  v_counts := public._vendor_business_open_work_counts(p_vendor_id, p_category_id);
  v_help := COALESCE((v_counts->>'help')::integer, 0);
  v_delivery := COALESCE((v_counts->>'delivery')::integer, 0);
  v_appointment := COALESCE((v_counts->>'appointment')::integer, 0);
  IF (v_help + v_delivery + v_appointment) > 0 THEN
    RAISE EXCEPTION 'pause_blocked_open_work'
      USING DETAIL = jsonb_build_object(
        'help', v_help,
        'delivery', v_delivery,
        'appointment', v_appointment
      )::text;
  END IF;

  SELECT v.subscription_status
  INTO v_sub
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF v_sub IS DISTINCT FROM 'trial' AND v_sub IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'pause_blocked_subscription'
      USING DETAIL = jsonb_build_object(
        'subscription_status', v_sub,
        'help', v_help,
        'delivery', v_delivery,
        'appointment', v_appointment
      )::text;
  END IF;
END;
$$;

COMMENT ON FUNCTION public._vendor_assert_can_start_pause(uuid, uuid) IS
  'Refuse pause start when the business has open work or subscription_status is not trial|active. Resume does not call this.';

REVOKE ALL ON FUNCTION public._vendor_assert_can_start_pause(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.vendor_update_category_profile(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee numeric;
  v_min numeric;
  v_was_paused boolean;
  v_want_paused boolean;
  v_is_resume boolean := false;
  v_open_id uuid;
  v_outcome jsonb := '{}'::jsonb;
  v_row public.vendor_billing_pauses%ROWTYPE;
  v_min_credit integer;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_patch ? 'inspection_fee' THEN
    IF p_patch->>'inspection_fee' IS NULL OR btrim(p_patch->>'inspection_fee') = '' THEN
      v_fee := NULL;
    ELSE
      v_fee := (p_patch->>'inspection_fee')::numeric;
      IF v_fee IS NOT NULL AND v_fee <= 0 THEN
        v_fee := NULL;
      END IF;
      IF v_fee IS NOT NULL AND v_fee > 99999 THEN
        RAISE EXCEPTION 'inspection_fee_invalid';
      END IF;
    END IF;
  END IF;

  IF p_patch ? 'min_delivery_order_amount' THEN
    IF p_patch->>'min_delivery_order_amount' IS NULL
       OR btrim(p_patch->>'min_delivery_order_amount') = '' THEN
      v_min := NULL;
    ELSE
      v_min := (p_patch->>'min_delivery_order_amount')::numeric;
      IF v_min IS NOT NULL AND v_min <= 0 THEN
        v_min := NULL;
      END IF;
      IF v_min IS NOT NULL AND v_min > 99999 THEN
        RAISE EXCEPTION 'min_delivery_order_amount_invalid';
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(vc.is_paused, false)
  INTO v_was_paused
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF p_patch ? 'is_paused' THEN
    v_want_paused := COALESCE((p_patch->>'is_paused')::boolean, false);
    IF v_want_paused = true AND COALESCE(v_was_paused, false) = false THEN
      PERFORM public._vendor_assert_can_start_pause(p_vendor_id, p_category_id);
    END IF;

    IF v_want_paused = false AND COALESCE(v_was_paused, false) = true THEN
      v_is_resume := true;
      SELECT w.id
      INTO v_open_id
      FROM public.vendor_billing_pauses w
      WHERE w.vendor_id = p_vendor_id
        AND w.ended_at IS NULL
      LIMIT 1;
    END IF;
  END IF;

  UPDATE public.vendor_categories vc
  SET
    brand_name = CASE
      WHEN p_patch ? 'brand_name' THEN NULLIF(trim(p_patch->>'brand_name'), '')
      ELSE vc.brand_name
    END,
    vendor_note = CASE
      WHEN p_patch ? 'vendor_note' THEN NULLIF(trim(p_patch->>'vendor_note'), '')
      ELSE vc.vendor_note
    END,
    serves_at_vendor_place = CASE
      WHEN p_patch ? 'serves_at_vendor_place' THEN (p_patch->>'serves_at_vendor_place')::boolean
      ELSE vc.serves_at_vendor_place
    END,
    serves_at_customer_place = CASE
      WHEN p_patch ? 'serves_at_customer_place' THEN (p_patch->>'serves_at_customer_place')::boolean
      ELSE vc.serves_at_customer_place
    END,
    service_radius_km = CASE
      WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::numeric
      ELSE vc.service_radius_km
    END,
    is_paused = CASE
      WHEN p_patch ? 'is_paused' THEN COALESCE((p_patch->>'is_paused')::boolean, false)
      ELSE vc.is_paused
    END,
    inspection_fee = CASE
      WHEN p_patch ? 'inspection_fee' THEN v_fee
      ELSE vc.inspection_fee
    END,
    min_delivery_order_amount = CASE
      WHEN p_patch ? 'min_delivery_order_amount' THEN v_min
      ELSE vc.min_delivery_order_amount
    END
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF v_is_resume THEN
    IF v_open_id IS NULL THEN
      v_outcome := jsonb_build_object(
        'credited_days', 0,
        'window_days', 0,
        'qualified', false,
        'reason', 'no_open_window'
      );
    ELSE
      SELECT * INTO v_row
      FROM public.vendor_billing_pauses w
      WHERE w.id = v_open_id;

      SELECT COALESCE(NULLIF(trim(value), '')::integer, 7)
      INTO v_min_credit
      FROM public.app_config
      WHERE key = 'pause_min_credit_days';
      v_min_credit := COALESCE(v_min_credit, 7);

      v_outcome := jsonb_build_object(
        'credited_days', COALESCE(v_row.credited_days, 0),
        'window_days', COALESCE(v_row.days, 0),
        'qualified', COALESCE(v_row.qualified, false),
        'reason', CASE
          WHEN v_row.ended_at IS NULL THEN 'no_open_window'
          WHEN v_row.qualified THEN 'credited'
          WHEN COALESCE(v_row.days, 0) < v_min_credit THEN 'below_min_credit_days'
          ELSE 'below_min_live_days'
        END
      );
    END IF;
  END IF;

  RETURN v_outcome;
END;
$$;

COMMENT ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) IS
  'Owner patch of per-business note/reach/pause/inspection_fee/min_delivery_order_amount. Returns {} except on resume, which returns credited_days/window_days/qualified/reason. Pause false->true refused when the business has open work or subscription_status is not trial|active.';

REVOKE ALL ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.vendor_pause_preflight(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_sub text;
  v_counts jsonb;
  v_help integer;
  v_delivery integer;
  v_appointment integer;
  v_open_total integer;
  v_khata_amount numeric;
  v_khata_customers integer;
  v_upi_claims integer;
  v_credit_days integer;
  v_will_freeze boolean;
  v_block text;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, NULL);

  SELECT v.phone, v.subscription_status
  INTO v_phone, v_sub
  FROM public.vendors v
  WHERE v.id = p_vendor_id
  LIMIT 1;

  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
  ) THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  v_counts := public._vendor_business_open_work_counts(p_vendor_id, p_category_id);
  v_help := COALESCE((v_counts->>'help')::integer, 0);
  v_delivery := COALESCE((v_counts->>'delivery')::integer, 0);
  v_appointment := COALESCE((v_counts->>'appointment')::integer, 0);
  v_open_total := v_help + v_delivery + v_appointment;

  SELECT
    COALESCE(SUM(kl.total_outstanding) FILTER (WHERE kl.total_outstanding > 0), 0),
    COUNT(*) FILTER (WHERE kl.total_outstanding > 0)
  INTO v_khata_amount, v_khata_customers
  FROM public.khata_ledger kl
  WHERE kl.vendor_id = p_vendor_id;

  SELECT COUNT(*)::integer
  INTO v_upi_claims
  FROM public.requests r
  WHERE r.vendor_id = p_vendor_id
    AND r.category_id = p_category_id
    AND r.payment_status = 'claimed';

  SELECT COALESCE(NULLIF(trim(value), '')::integer, 7)
  INTO v_credit_days
  FROM public.app_config
  WHERE key = 'pause_min_credit_days';
  v_credit_days := COALESCE(v_credit_days, 7);

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND vc.category_id IS DISTINCT FROM p_category_id
      AND COALESCE(vc.is_paused, false) = false
  )
  INTO v_will_freeze;

  v_block := NULL;
  IF v_open_total > 0 THEN
    v_block := 'open_work';
  ELSIF v_sub IS DISTINCT FROM 'trial' AND v_sub IS DISTINCT FROM 'active' THEN
    v_block := 'subscription_state';
  END IF;

  RETURN jsonb_build_object(
    'can_pause', v_block IS NULL,
    'block_reason', v_block,
    'open_work', jsonb_build_object(
      'help', v_help,
      'delivery', v_delivery,
      'appointment', v_appointment
    ),
    'khata', jsonb_build_object(
      'pending_amount', v_khata_amount,
      'customer_count', v_khata_customers
    ),
    'upi_claims_pending', v_upi_claims,
    'subscription_status', v_sub,
    'will_freeze_billing', v_will_freeze,
    'pause_min_credit_days', v_credit_days
  );
END;
$$;

COMMENT ON FUNCTION public.vendor_pause_preflight(uuid, uuid) IS
  'Owner preflight before pausing one business. Hybrid session assert when Auth is present. can_pause only when no open work and subscription_status is trial|active.';

REVOKE ALL ON FUNCTION public.vendor_pause_preflight(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_pause_preflight(uuid, uuid)
  TO anon, authenticated, service_role;
