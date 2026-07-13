-- Drop PROD-only rogue trigger update_khata_ledger / trigger_update_khata_ledger.
--
-- This trigger existed only on PROD, outside version control, and recomputed
-- khata_ledger.total_outstanding as SUM(payment_mode='khata') while ignoring
-- payment_mode='paid' rows entirely — meaning any khata insert after a payment
-- would silently erase that payment's effect on the customer's balance.
--
-- All ledger math is already correctly and atomically handled by
-- vendor_record_khata_payment, vendor_record_khata_refund, add_bill_to_khata,
-- and insert_bill_with_items directly; this trigger was redundant and actively
-- incorrect.
--
-- payment_mode values in use (PROD audit + RPC definitions):
--   'khata' — charges, bill deltas, and customer-credit refunds (positive amount)
--   'paid'  — customer payments reducing outstanding (positive amount)
-- No separate 'refund' payment_mode exists; refunds are inserted as 'khata'
-- with note 'Refund to customer' and correctly belong in the khata SUM.

DROP TRIGGER IF EXISTS trigger_update_khata_ledger ON public.khata_transactions;
DROP FUNCTION IF EXISTS public.update_khata_ledger();

-- One-time correction: recompute every ledger row from transactions.
-- outstanding = SUM(khata) - SUM(paid)
UPDATE public.khata_ledger kl
SET
  total_outstanding = COALESCE((
    SELECT
      COALESCE(SUM(CASE WHEN kt.payment_mode = 'khata' THEN kt.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN kt.payment_mode = 'paid' THEN kt.amount ELSE 0 END), 0)
    FROM public.khata_transactions kt
    WHERE kt.vendor_id = kl.vendor_id
      AND kt.user_phone = kl.user_phone
  ), 0),
  last_updated = now();
