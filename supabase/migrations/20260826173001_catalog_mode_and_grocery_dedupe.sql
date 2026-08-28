-- Catalog corrections (applied live TEST+PROD 2026-08-26):
-- 1) Default mode: Painter/Carpenter/Laundry/Maid/Security/Nursing/Cobbler → appointment
--    (urgent-vs-scheduled axis; reach is separate)
-- 2) Deactivate duplicate Grocery; keep Grocery Store canonical.
--    Live apply migrated vendor_categories + vendors.category text to Grocery Store first.

UPDATE public.categories
SET service_mode = 'appointment'
WHERE label IN (
  'Painter', 'Carpenter', 'Laundry', 'Maid', 'Security', 'Nursing', 'Cobbler'
)
AND service_mode IS DISTINCT FROM 'appointment';

-- Migrate any remaining Grocery vendor_categories → Grocery Store (idempotent).
UPDATE public.vendor_categories vc
SET category_id = gs.id
FROM public.categories g
JOIN public.categories gs ON gs.label = 'Grocery Store'
WHERE g.label = 'Grocery'
  AND vc.category_id = g.id
  AND NOT EXISTS (
    SELECT 1 FROM public.vendor_categories x
    WHERE x.vendor_id = vc.vendor_id AND x.category_id = gs.id
  );

UPDATE public.vendors
SET category = 'Grocery Store'
WHERE category = 'Grocery';

UPDATE public.categories
SET is_active = false,
    pending_review = false
WHERE label = 'Grocery'
  AND is_active IS DISTINCT FROM false;
