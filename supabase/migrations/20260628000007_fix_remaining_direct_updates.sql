-- SECURITY DEFINER RPCs for requests updates while OTP auth is disabled (localStorage identity).

CREATE OR REPLACE FUNCTION public._customer_owns_request(
  p_request_id uuid,
  p_device_id text,
  p_user_phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.requests r
    WHERE r.id = p_request_id
      AND (
        (p_user_phone IS NOT NULL AND r.user_phone = p_user_phone)
        OR (p_device_id IS NOT NULL AND r.device_id = p_device_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public._vendor_owns_request(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.requests r
    JOIN public.vendors v ON v.id = r.vendor_id
    WHERE r.id = p_request_id
      AND r.vendor_id = p_vendor_id
      AND v.phone = p_vendor_phone
  );
$$;

-- ── Customer ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_customer_order(
  p_request_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
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

  UPDATE public.requests
  SET status = 'cancelled'
  WHERE id = p_request_id
    AND status IN ('sent', 'seen')
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_customer_order(
  p_request_id uuid,
  p_message text,
  p_previous_message text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
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

  UPDATE public.requests
  SET
    message = p_message,
    previous_message = p_previous_message,
    is_edited = true
  WHERE id = p_request_id
    AND status IN ('sent', 'seen')
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_editable_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_customer_payment(
  p_request_id uuid,
  p_payment_utr text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
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

  UPDATE public.requests
  SET
    payment_utr = p_payment_utr,
    payment_status = 'claimed',
    payment_claimed_at = now()
  WHERE id = p_request_id
    AND status = 'fulfilled'
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.migrate_device_requests_phone(
  p_device_id text,
  p_user_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_device_id IS NULL OR p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.requests
  SET user_phone = p_user_phone
  WHERE device_id = p_device_id
    AND (user_phone IS NULL OR user_phone <> p_user_phone);
END;
$$;

-- ── Vendor ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_clear_order_edited(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._vendor_owns_request(p_request_id, p_vendor_id, p_vendor_phone) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.requests
  SET is_edited = false
  WHERE id = p_request_id
    AND is_edited = true;
END;
$$;

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
  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RETURN;
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

CREATE OR REPLACE FUNCTION public.vendor_mark_sent_seen(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests r
  SET status = 'seen'
  FROM public.vendors v
  WHERE r.vendor_id = p_vendor_id
    AND r.status = 'sent'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_accept_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_from_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.requests r
  SET status = 'accepted'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND r.status = p_from_status
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_fulfil_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests r
  SET status = 'fulfilled'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_confirm_appointment(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests r
  SET
    appointment_status = 'confirmed',
    status = 'accepted'
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_decline_booking(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_cancel_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests r
  SET
    appointment_status = 'declined',
    status = 'seen',
    cancel_reason = p_cancel_reason
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_cancel_order(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_cancel_reason text,
  p_cancel_appointment boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests r
  SET
    status = 'cancelled',
    cancel_reason = p_cancel_reason,
    appointment_status = CASE
      WHEN p_cancel_appointment THEN 'cancelled'::text
      ELSE r.appointment_status
    END
  FROM public.vendors v
  WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- Grants
REVOKE ALL ON FUNCTION public._customer_owns_request(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._vendor_owns_request(uuid, uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.cancel_customer_order(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_customer_order(uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.edit_customer_order(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_customer_order(uuid, text, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.claim_customer_payment(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_payment(uuid, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.migrate_device_requests_phone(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_device_requests_phone(text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_clear_order_edited(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_clear_order_edited(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_dismiss_requests(uuid, text, uuid[]) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_mark_sent_seen(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_mark_sent_seen(uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_accept_order(uuid, uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_fulfil_order(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_confirm_appointment(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_confirm_appointment(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_decline_booking(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_decline_booking(uuid, uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_cancel_order(uuid, uuid, text, text, boolean) TO anon, authenticated;
