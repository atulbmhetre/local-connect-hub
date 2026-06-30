-- Vendor edit-shop: replace vendor_categories without auth_user_phone() RLS (OTP-off localStorage identity).

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cat_count integer;
  v_needs_review boolean;
  i integer;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors
    WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);
  IF v_cat_count = 0 THEN
    RAISE EXCEPTION 'category_ids_required';
  END IF;

  IF p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  v_needs_review := v_cat_count >= 3;

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id;

  FOR i IN 1..v_cat_count LOOP
    INSERT INTO public.vendor_categories (
      vendor_id,
      category_id,
      is_primary,
      status,
      needs_review,
      service_mode
    )
    VALUES (
      p_vendor_id,
      p_category_ids[i],
      i = 1,
      'approved',
      v_needs_review,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), 'help')
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[])
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[])
  TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[]) IS
  'Replaces vendor_categories for a vendor after phone ownership check. ≥3 categories sets needs_review on all rows.';
