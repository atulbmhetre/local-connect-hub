-- Fix infinite RLS recursion from 20260830120001: vendors_public_discoverable_read
-- queried vendor_categories, while vendor_categories_owner queries vendors.
-- Use a SECURITY DEFINER helper so the vendors policy can check pause without
-- re-entering vendor_categories RLS.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public.vendor_has_discoverable_business(p_vendor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.status = 'approved'
    )
    OR EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.status = 'approved'
        AND COALESCE(vc.is_paused, false) = false
    );
$$;

COMMENT ON FUNCTION public.vendor_has_discoverable_business(uuid) IS
  'True when the vendor has no approved businesses (legacy) or at least one approved unpaused business. SECURITY DEFINER so vendors RLS can check pause without recursing into vendor_categories policies.';

REVOKE ALL ON FUNCTION public.vendor_has_discoverable_business(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_has_discoverable_business(uuid)
  TO anon, authenticated, service_role;

DROP POLICY IF EXISTS vendors_public_discoverable_read ON public.vendors;

CREATE POLICY vendors_public_discoverable_read ON public.vendors
  FOR SELECT
  TO anon, authenticated
  USING (
    discoverable = true
    AND is_banned = false
    AND profile_status = 'complete'
    AND deletion_requested_at IS NULL
    AND public.vendor_has_discoverable_business(id)
  );

COMMENT ON POLICY vendors_public_discoverable_read ON public.vendors IS
  'Customer discovery: discoverable, non-banned, complete profiles not scheduled for deletion, with at least one unpaused approved business (or no vendor_categories rows). Pause check is SECURITY DEFINER to avoid RLS recursion.';
