-- Remove Therapist from the category catalog.
-- Pre-check: only deletes rows with no vendor_categories references.
-- Applied live to TEST + PROD 2026-08-26 after confirming 0 vendor_categories / requests.

DELETE FROM public.categories c
WHERE c.label = 'Therapist'
  AND NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.category_id = c.id
  );
