-- Public per-business operational stats for Radar / AiBridge.
-- Mirrors client buildCategoryOrderStats (fulfilled + on-time) keyed by
-- vendor_id + category_id. Account-wide vendors.total_helped / total_delivered /
-- on_time_rate remain unchanged (VendorMode account rollup / legacy increments).

CREATE OR REPLACE FUNCTION public.get_public_vendor_category_order_stats(
  p_vendor_ids uuid[],
  p_category_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  vendor_id uuid,
  category_id uuid,
  fulfilled integer,
  on_time_rate numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_ids IS NULL OR cardinality(p_vendor_ids) = 0 THEN
    RETURN;
  END IF;

  -- Cap fan-out for Radar result sets.
  IF cardinality(p_vendor_ids) > 200 THEN
    RAISE EXCEPTION 'too_many_vendor_ids';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      r.vendor_id,
      r.category_id,
      r.status,
      r.delivery_slot_deadline,
      r.fulfilled_at
    FROM public.requests r
    WHERE r.vendor_id = ANY (p_vendor_ids)
      AND r.category_id IS NOT NULL
      AND (
        p_category_ids IS NULL
        OR cardinality(p_category_ids) = 0
        OR r.category_id = ANY (p_category_ids)
      )
      AND r.status IN ('fulfilled', 'done')
  ),
  with_deadline AS (
    SELECT
      s.vendor_id,
      s.category_id,
      COUNT(*)::integer AS n,
      COUNT(*) FILTER (
        WHERE s.fulfilled_at IS NOT NULL
          AND s.delivery_slot_deadline IS NOT NULL
          AND s.fulfilled_at <= s.delivery_slot_deadline
      )::integer AS on_time_n,
      COUNT(*) FILTER (
        WHERE s.fulfilled_at IS NOT NULL
          AND s.delivery_slot_deadline IS NOT NULL
      )::integer AS deadline_n
    FROM scoped s
    GROUP BY s.vendor_id, s.category_id
  )
  SELECT
    w.vendor_id,
    w.category_id,
    w.n AS fulfilled,
    CASE
      WHEN w.deadline_n > 0 THEN round((w.on_time_n::numeric / w.deadline_n::numeric) * 100, 1)
      ELSE NULL
    END AS on_time_rate
  FROM with_deadline w;
END;
$$;

COMMENT ON FUNCTION public.get_public_vendor_category_order_stats(uuid[], uuid[]) IS
  'Customer-facing per-business fulfilled count + on-time rate for Radar/AiBridge. No PII.';

REVOKE ALL ON FUNCTION public.get_public_vendor_category_order_stats(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_vendor_category_order_stats(uuid[], uuid[]) TO anon, authenticated, service_role;
