-- Outcomes must persist even if the order row is already deleted (callback lag).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.vendor_call_outcomes
  DROP CONSTRAINT IF EXISTS vendor_call_outcomes_request_id_fkey;
