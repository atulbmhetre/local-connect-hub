-- Customer-facing Local Feed posts (target_audience = 'customers') are visible
-- to every reader, including devices with an active vendor session.
-- Vendors-only / both + category scoping for vendor readers is unchanged.
-- Opt-out of A&R push remains user_devices.feed_notifications_enabled
-- (notify path only - not this display matcher).

CREATE OR REPLACE FUNCTION public.feed_post_matches_reader_audience(
  p_target_audience text,
  p_target_category_id uuid,
  p_reader_vendor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_vendor boolean;
  v_audience text;
BEGIN
  v_audience := COALESCE(NULLIF(trim(p_target_audience), ''), 'customers');
  v_is_vendor := p_reader_vendor_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = p_reader_vendor_id);

  -- Customer-facing posts: visible to everyone (customer or vendor session).
  IF v_audience = 'customers' THEN
    RETURN true;
  END IF;

  IF v_is_vendor THEN
    -- Vendor-targeted posts: audience must include vendors; category null = all.
    RETURN v_audience IN ('vendors', 'both')
      AND (
        p_target_category_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.vendor_categories vc
          WHERE vc.vendor_id = p_reader_vendor_id
            AND vc.category_id = p_target_category_id
            AND vc.status = 'approved'
        )
      );
  END IF;

  -- Pure customer readers: see both (customers already returned above).
  RETURN v_audience = 'both';
END;
$$;

COMMENT ON FUNCTION public.feed_post_matches_reader_audience(text, uuid, uuid) IS
  'Local Feed audience: customers posts visible to all readers; vendors/both still gated for vendor readers by category.';
