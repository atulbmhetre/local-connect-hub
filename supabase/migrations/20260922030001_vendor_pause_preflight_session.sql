-- vendor_pause_preflight returns khata amounts. Require the same hybrid session
-- check as khata payment RPCs, refuse JWT callers who are not this vendor, and
-- revoke anon execute so an unauthenticated call cannot read the payload.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

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
  IF auth.uid() IS NOT NULL
     AND NULLIF(btrim(COALESCE(public.auth_user_phone(), '')), '') IS NULL THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

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
  'Owner preflight before pausing one business. Session must match the vendor when Auth is present; anon cannot execute.';

REVOKE ALL ON FUNCTION public.vendor_pause_preflight(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_pause_preflight(uuid, uuid)
  TO authenticated, service_role;
