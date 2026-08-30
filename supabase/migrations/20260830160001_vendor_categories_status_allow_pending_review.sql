-- The live vendor_categories_status_check predates pending_review (soft-cap
-- 6th+ businesses). 20260830150001 only ADDed the constraint if missing, so
-- TEST kept the old allowed set and the insert trigger could not write
-- pending_review. Recreate the check with the extra status.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_status_check;

ALTER TABLE public.vendor_categories
  ADD CONSTRAINT vendor_categories_status_check
  CHECK (status IN ('approved', 'pending_review', 'rejected', 'pending'));
