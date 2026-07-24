-- Extend get_my_help_banner_orders so Home can filter live-location orders
-- (Help + instant Delivery/Appointment) using the same instant signals as
-- vendorTrackingPolicy (delivery_slot = asap; appointment_time ≈ created_at + 2h).
-- Return shape change requires DROP first (42P13).

DROP FUNCTION IF EXISTS public.get_my_help_banner_orders(text);

CREATE FUNCTION public.get_my_help_banner_orders(
  p_user_phone text
)
RETURNS TABLE (
  id uuid,
  status text,
  updated_at timestamptz,
  created_at timestamptz,
  delivery_slot text,
  appointment_time timestamptz,
  vendor_shop_name text,
  vendor_service_mode text,
  vendor_last_updated timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_my_help_banner_orders', 'phone', btrim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT r.id, r.status, r.updated_at, r.created_at, r.delivery_slot, r.appointment_time,
         v.shop_name,
         COALESCE(r.service_mode, v.service_mode) AS vendor_service_mode,
         v.last_updated
  FROM public.requests r
  LEFT JOIN public.vendors v ON v.id = r.vendor_id
  WHERE r.user_phone = btrim(p_user_phone)
    AND r.status = 'accepted'
    AND r.updated_at > now() - interval '48 hours'
  ORDER BY r.updated_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_help_banner_orders(text) IS
  'Own accepted orders updated in the last 48h with vendor + instant-slot fields, for the Home live-location banner. OTP-off read path; live-scope filter stays client-side.';

REVOKE ALL ON FUNCTION public.get_my_help_banner_orders(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_help_banner_orders(text) TO anon, authenticated, service_role;
