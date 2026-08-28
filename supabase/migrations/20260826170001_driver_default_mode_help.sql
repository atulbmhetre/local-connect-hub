-- Catalog default mode: Driver is chauffeur/on-demand help, not goods delivery.
-- Applied live to TEST + PROD 2026-08-26 (service_mode only).

UPDATE public.categories
SET service_mode = 'help'
WHERE label = 'Driver'
  AND service_mode IS DISTINCT FROM 'help';
