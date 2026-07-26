-- PROD still has order_bills_payment_status_check as unpaid|paid only.
-- Cancel / void RPCs have written payment_status = 'void' since at least
-- 20260628000008 (vendor_void_unpaid_bills) and 20260715160001 (cancel RPCs),
-- but no migration ever widened this CHECK. TEST works because the constraint
-- is absent there; PROD fails with 23514 on void.
-- Align allowed values to unpaid | paid | void (keep the CHECK; do not drop it).

ALTER TABLE public.order_bills
  DROP CONSTRAINT IF EXISTS order_bills_payment_status_check;

ALTER TABLE public.order_bills
  ADD CONSTRAINT order_bills_payment_status_check
  CHECK (payment_status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'void'::text]));
