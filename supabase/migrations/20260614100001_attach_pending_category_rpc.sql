-- VR-REG-03: Atomically replace vendor_categories when a pending category is created post-register.

CREATE OR REPLACE FUNCTION public.attach_pending_category(
  p_vendor_id uuid,
  p_category_id uuid,
  p_service_mode text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id;

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
    p_category_id,
    true,
    'approved',
    false,
    trim(p_service_mode)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attach_pending_category(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.attach_pending_category(uuid, uuid, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.attach_pending_category(uuid, uuid, text) IS
  'Replaces all vendor_categories for a vendor with one pending/new category row (single transaction).';
