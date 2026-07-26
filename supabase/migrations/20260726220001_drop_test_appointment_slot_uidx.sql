-- Drop TEST-resurfaced appointment double-booking unique index.
-- Product decision (20260715170001): informal-market vendors may serve overlapping
-- appointments; hard UNIQUE was replaced by a soft UI warning. PROD never kept this
-- index; TEST somehow still had it and it kept showing as false structural drift.
-- Idempotent: no-op on PROD.

DROP INDEX IF EXISTS public.requests_vendor_appointment_slot_uidx;
