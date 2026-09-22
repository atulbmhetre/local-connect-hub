-- Fully paused = at least one approved business, and every approved business is paused.
-- Pending / rejected / no businesses must not open a billing window or earn credit.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public._vendor_account_is_fully_paused(p_vendor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.status = 'approved'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.status = 'approved'
        AND COALESCE(vc.is_paused, false) = false
    );
$$;

COMMENT ON FUNCTION public._vendor_account_is_fully_paused(uuid) IS
  'True only when the vendor has at least one approved business and every approved business is paused. Pending, rejected, or no businesses are not fully paused.';

-- Close open windows that the new definition does not treat as fully paused.
-- Do this WITHOUT calling _sync_vendor_billing_pause: a long wrongly-open
-- window would otherwise close-and-credit.
UPDATE public.vendor_billing_pauses w
SET
  ended_at = now(),
  days = GREATEST(FLOOR(EXTRACT(EPOCH FROM (now() - w.started_at)) / 86400.0)::integer, 0),
  credited_days = 0,
  qualified = false
WHERE w.ended_at IS NULL
  AND NOT public._vendor_account_is_fully_paused(w.vendor_id);

-- Reverse credit already posted from windows on vendors with zero approved businesses.
UPDATE public.vendors v
SET pause_credit_days = GREATEST(
  COALESCE(v.pause_credit_days, 0) - sub.credit,
  0
)
FROM (
  SELECT w.vendor_id, SUM(w.credited_days)::integer AS credit
  FROM public.vendor_billing_pauses w
  WHERE COALESCE(w.credited_days, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = w.vendor_id
        AND vc.status = 'approved'
    )
  GROUP BY w.vendor_id
) sub
WHERE v.id = sub.vendor_id;

UPDATE public.vendor_billing_pauses w
SET
  credited_days = 0,
  qualified = false
WHERE COALESCE(w.credited_days, 0) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = w.vendor_id
      AND vc.status = 'approved'
  );
