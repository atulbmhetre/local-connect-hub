-- Section 5c: after disputing a claimed payment, log the event and enforce the
-- two-distinct-vendor cash-only backstop on customer_payment_restrictions.

CREATE OR REPLACE FUNCTION public.dispute_upi_payment(
  p_request_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_phone text;
  v_device_id text;
  v_vendor_id uuid;
  v_identity_key text;
  v_distinct_vendors integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.requests
    WHERE id = p_request_id AND payment_status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  UPDATE public.requests
  SET payment_status = 'disputed'
  WHERE id = p_request_id
  RETURNING user_phone, device_id, vendor_id
  INTO v_user_phone, v_device_id, v_vendor_id;

  INSERT INTO public.payment_dispute_events (
    request_id,
    vendor_id,
    user_phone,
    device_id
  )
  VALUES (
    p_request_id,
    v_vendor_id,
    v_user_phone,
    v_device_id
  );

  v_identity_key := public._customer_payment_identity_key(v_user_phone, v_device_id);
  IF v_identity_key IS NULL THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT e.vendor_id)::integer
  INTO v_distinct_vendors
  FROM public.payment_dispute_events e
  WHERE public._customer_payment_identity_key(e.user_phone, e.device_id) = v_identity_key;

  INSERT INTO public.customer_payment_restrictions (
    identity_key,
    is_restricted,
    restricted_at,
    last_dispute_at
  )
  VALUES (
    v_identity_key,
    v_distinct_vendors >= 2,
    CASE WHEN v_distinct_vendors >= 2 THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (identity_key) DO UPDATE
  SET
    last_dispute_at = now(),
    is_restricted = customer_payment_restrictions.is_restricted
      OR (v_distinct_vendors >= 2),
    restricted_at = CASE
      WHEN v_distinct_vendors >= 2
        AND customer_payment_restrictions.restricted_at IS NULL
        THEN now()
      WHEN v_distinct_vendors >= 2
        AND NOT customer_payment_restrictions.is_restricted
        THEN now()
      ELSE customer_payment_restrictions.restricted_at
    END;
END;
$$;

COMMENT ON FUNCTION public.dispute_upi_payment(uuid, text) IS
  'Vendor disputes a claimed UPI payment; logs dispute event and may restrict customer self-declare pay after 2 distinct vendors.';

REVOKE ALL ON FUNCTION public.dispute_upi_payment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_upi_payment(uuid, text) TO anon, authenticated;
