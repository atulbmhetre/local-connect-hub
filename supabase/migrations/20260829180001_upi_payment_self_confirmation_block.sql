-- Block same-device customer self-confirm/dispute of a claimed UPI payment.
-- p_device_id is optional (NULL = skip this check) so existing 2-arg callers keep working.
--
-- LIMITATION (not a complete ownership fix): this does NOT close third-party spoofing.
-- Anyone who knows the request's vendor phone and calls from a device_id that is NOT
-- the order's requests.device_id still passes. No vendor session / auth_user_phone()
-- is required. This only rejects the most likely exploit: the customer confirming or
-- disputing their own order from the same browser/app device they used to place it.

DROP FUNCTION IF EXISTS public.confirm_upi_payment(uuid, text);
DROP FUNCTION IF EXISTS public.dispute_upi_payment(uuid, text);

CREATE OR REPLACE FUNCTION public.confirm_upi_payment(
  p_request_id uuid,
  p_vendor_phone text,
  p_device_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised';
  END IF;

  -- Same-device self-confirm only. Different device_id + vendor phone still succeeds.
  IF p_device_id IS NOT NULL AND trim(p_device_id) <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.requests r
      WHERE r.id = p_request_id
        AND r.device_id IS NOT NULL
        AND trim(r.device_id) <> ''
        AND trim(r.device_id) = trim(p_device_id)
    ) THEN
      RAISE EXCEPTION 'self_confirmation_blocked';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.requests
    WHERE id = p_request_id AND payment_status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;

  UPDATE public.requests
  SET payment_status = 'confirmed', payment_confirmed_at = now()
  WHERE id = p_request_id;

  UPDATE public.order_bills
  SET payment_status = 'paid', paid_at = now()
  WHERE request_id = p_request_id;
END;
$$;

COMMENT ON FUNCTION public.confirm_upi_payment(uuid, text, text) IS
  'Vendor confirms a claimed UPI payment. Optional p_device_id blocks same-device self-confirm; does not prove vendor session or stop other-device spoofing.';

REVOKE ALL ON FUNCTION public.confirm_upi_payment(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_upi_payment(uuid, text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dispute_upi_payment(
  p_request_id uuid,
  p_vendor_phone text,
  p_device_id text DEFAULT NULL
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

  -- Same-device self-dispute only. Different device_id + vendor phone still succeeds.
  IF p_device_id IS NOT NULL AND trim(p_device_id) <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.requests r
      WHERE r.id = p_request_id
        AND r.device_id IS NOT NULL
        AND trim(r.device_id) <> ''
        AND trim(r.device_id) = trim(p_device_id)
    ) THEN
      RAISE EXCEPTION 'self_confirmation_blocked';
    END IF;
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

COMMENT ON FUNCTION public.dispute_upi_payment(uuid, text, text) IS
  'Vendor disputes a claimed UPI payment; logs dispute event and may restrict customer self-declare pay after 2 distinct vendors. Optional p_device_id blocks same-device self-dispute; does not prove vendor session or stop other-device spoofing.';

REVOKE ALL ON FUNCTION public.dispute_upi_payment(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_upi_payment(uuid, text, text) TO anon, authenticated, service_role;
