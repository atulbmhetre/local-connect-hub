-- Replace admin UPI arbitration (20260905280001) with the narrow product fix:
-- allow dismiss while request payment_status is disputed + bill still unpaid.
-- Dispute record stays on the request; call / Bill Edit / ratings remain the
-- resolution path — no admin deciding winners.

-- ── Drop mistaken admin resolve path ─────────────────────────────────────────
REVOKE ALL ON FUNCTION public.admin_resolve_disputed_upi_payment(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.admin_resolve_disputed_upi_payment(uuid, text, text);

-- Revert requests.payment_status 'void' (only existed for admin write-off).
UPDATE public.requests
SET payment_status = 'disputed'
WHERE payment_status = 'void';

ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_payment_status_check;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_payment_status_check
  CHECK (payment_status IN ('unpaid', 'claimed', 'confirmed', 'disputed'));

-- Restore 48h block helper without the void terminal (matches pre-admin-resolve).
CREATE OR REPLACE FUNCTION public._customer_find_blocking_digital_payment_bill(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  request_id uuid,
  vendor_name text,
  amount double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id AS request_id,
    COALESCE(
      NULLIF(btrim(v.shop_name), ''),
      NULLIF(btrim(v.name), ''),
      'Vendor'
    ) AS vendor_name,
    ob.total_amount AS amount
  FROM public.order_bills ob
  INNER JOIN public.requests r ON r.id = ob.request_id
  INNER JOIN public.vendors v ON v.id = ob.vendor_id
  WHERE ob.payment_status = 'unpaid'
    AND ob.payment_mode = 'upi'
    AND ob.created_at < now() - interval '48 hours'
    AND r.service_mode = 'delivery'
    AND r.delivery_fulfillment_method = 'agent'
    AND r.delivery_payment_timing = 'prepaid'
    AND r.status NOT IN ('cancelled', 'done')
    AND COALESCE(r.payment_status, 'unpaid') NOT IN ('claimed', 'confirmed', 'disputed')
    AND (
      (
        p_user_phone IS NOT NULL
        AND btrim(p_user_phone) <> ''
        AND (
          ob.user_phone = btrim(p_user_phone)
          OR r.user_phone = btrim(p_user_phone)
          OR (
            p_device_id IS NOT NULL
            AND btrim(p_device_id) <> ''
            AND r.device_id IS NOT NULL
            AND r.device_id = btrim(p_device_id)
          )
        )
      )
      OR (
        (p_user_phone IS NULL OR btrim(p_user_phone) = '')
        AND p_device_id IS NOT NULL
        AND btrim(p_device_id) <> ''
        AND r.device_id IS NOT NULL
        AND r.device_id = btrim(p_device_id)
      )
    )
  ORDER BY ob.created_at ASC
  LIMIT 1;
$$;

-- ── Dismiss: unpaid cash/UPI still blocks, unless payment is disputed ────────

CREATE OR REPLACE FUNCTION public.dismiss_order(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL,
  p_appointment_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL AND p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_bills ob
    JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.request_id = p_request_id
      AND ob.payment_status = 'unpaid'
      AND lower(btrim(coalesce(ob.payment_mode, ''))) IN ('cash', 'upi', '')
      AND coalesce(r.payment_status, '') IS DISTINCT FROM 'disputed'
  ) THEN
    RAISE EXCEPTION 'dismiss_blocked_unpaid_bill';
  END IF;

  UPDATE public.requests
  SET
    status = 'done',
    appointment_status = COALESCE(p_appointment_status, appointment_status)
  WHERE id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR
      (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.dismiss_order(uuid, text, text, text) IS
  'Customer dismisses order to done. Unpaid cash/UPI blocks unless request payment_status is disputed (dispute stays recorded).';

CREATE OR REPLACE FUNCTION public.vendor_dismiss_requests(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_request_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);
  PERFORM public._assert_vendor_not_banned(p_vendor_id, p_vendor_phone);

  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_bills ob
    JOIN public.requests r ON r.id = ob.request_id
    WHERE ob.request_id = ANY (p_request_ids)
      AND r.vendor_id = p_vendor_id
      AND ob.payment_status = 'unpaid'
      AND lower(btrim(coalesce(ob.payment_mode, ''))) IN ('cash', 'upi', '')
      AND coalesce(r.payment_status, '') IS DISTINCT FROM 'disputed'
  ) THEN
    RAISE EXCEPTION 'dismiss_blocked_unpaid_bill';
  END IF;

  UPDATE public.requests r
  SET status = 'done'
  FROM public.vendors v
  WHERE r.id = ANY (p_request_ids)
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

COMMENT ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) IS
  'Vendor dismisses requests to done. Unpaid cash/UPI blocks unless request payment_status is disputed. Soft hybrid + ban assert.';

REVOKE ALL ON FUNCTION public.dismiss_order(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_order(uuid, text, text, text)
  TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[])
  TO anon, authenticated, service_role;
