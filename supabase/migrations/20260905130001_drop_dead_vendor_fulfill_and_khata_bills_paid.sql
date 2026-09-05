-- Drop dead RPCs with zero callers in src/tests/scripts/functions.
-- Live twin for fulfilment is vendor_fulfil_order; khata bill marking is unused.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

REVOKE ALL ON FUNCTION public.vendor_fulfill_order(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.vendor_mark_customer_khata_bills_paid(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.vendor_fulfill_order(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.vendor_mark_customer_khata_bills_paid(uuid, text, text);
