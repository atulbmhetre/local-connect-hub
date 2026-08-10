-- Fix vendor_promote_green_pending to check per-business photos instead of account-level photo.
--
-- CONTEXT: After Phase 3, photo verification moved from account-level (vendors.shop_photo_url)
-- to per-business (vendor_categories.shop_photo_url). The green promotion logic still required
-- the stale account-level field, potentially blocking vendors whose businesses are photo-ready
-- but whose account-level field was never populated.
--
-- CHANGE: Replace `v.shop_photo_url IS NOT NULL` with a check for at least one
-- `vendor_categories` row with a valid `shop_photo_url`.

CREATE OR REPLACE FUNCTION public.vendor_promote_green_pending(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.vendors v
  SET verification_status = 'green_pending'
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone)
    AND v.verification_status = 'business_verified'
    AND v.is_manual_verified IS NOT TRUE
    AND v.photo_selfie IS NOT NULL
    AND trim(v.photo_selfie) <> ''
    AND v.upi_verified IS TRUE
    AND regexp_replace(COALESCE(v.phone, ''), '[\s-]', '', 'g') ~ '^(\+?91)?[6-9][0-9]{9}$'
    -- Check for at least one business with shop photo instead of account-level photo
    AND EXISTS (
      SELECT 1 FROM public.vendor_categories vc
      WHERE vc.vendor_id = v.id
        AND vc.shop_photo_url IS NOT NULL
        AND trim(vc.shop_photo_url) <> ''
    );

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.vendor_promote_green_pending(uuid, text) IS
  'Marks green_pending when full green criteria met incl. selfie and per-business photo. Requires phone ownership.';