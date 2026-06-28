-- Drop the old 14-parameter register_vendor function (without p_upi_qr_url).
-- The correct version is the 15-parameter one added in Session 55 which includes p_upi_qr_url.
-- Having both causes PGRST203 ambiguity error when calling without explicit p_upi_qr_url.
DROP FUNCTION IF EXISTS public.register_vendor(
  p_name text, p_shop_name text, p_category text, p_phone text,
  p_upi_id text, p_service_mode text, p_vendor_type text, p_vendor_note text,
  p_latitude double precision, p_longitude double precision,
  p_referral_code text, p_profile_status text,
  p_category_ids uuid[], p_category_service_modes text[]
);
