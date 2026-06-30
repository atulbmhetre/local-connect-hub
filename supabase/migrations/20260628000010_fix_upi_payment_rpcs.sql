-- Fix 1: UPI payment RPCs accept explicit vendor phone (no auth_user_phone()).
-- Fix 2: Vendor khata ledger customer names via SECURITY DEFINER RPC.

DROP FUNCTION IF EXISTS public.confirm_upi_payment(uuid);
DROP FUNCTION IF EXISTS public.dispute_upi_payment(uuid);

CREATE OR REPLACE FUNCTION public.confirm_upi_payment(
  p_request_id uuid,
  p_vendor_phone text
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
REVOKE ALL ON FUNCTION public.confirm_upi_payment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_upi_payment(uuid, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.dispute_upi_payment(
  p_request_id uuid,
  p_vendor_phone text
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
  IF NOT EXISTS (
    SELECT 1 FROM public.requests
    WHERE id = p_request_id AND payment_status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'payment_not_claimed';
  END IF;
  UPDATE public.requests
  SET payment_status = 'disputed'
  WHERE id = p_request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.dispute_upi_payment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_upi_payment(uuid, text) TO anon, authenticated;

-- Fix 2: drop broken SELECT policy; vendor ledger names via explicit phone RPC.
DROP POLICY IF EXISTS app_users_vendor_ledger_select ON public.app_users;

CREATE OR REPLACE FUNCTION public.get_vendor_customer_names(
  p_vendor_phone text
)
RETURNS TABLE(phone text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    kl.user_phone AS phone,
    NULLIF(TRIM(au.name), '') AS name
  FROM public.khata_ledger kl
  INNER JOIN public.vendors v ON v.id = kl.vendor_id
  LEFT JOIN public.app_users au ON au.phone = kl.user_phone
  WHERE v.phone = p_vendor_phone
    AND kl.user_phone IS NOT NULL;
$$;

COMMENT ON FUNCTION public.get_vendor_customer_names(text) IS
  'Returns customer phone/name pairs for a vendor khata ledger. SECURITY DEFINER — bypasses app_users RLS while OTP auth is disabled.';

REVOKE ALL ON FUNCTION public.get_vendor_customer_names(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_customer_names(text) TO anon, authenticated;
