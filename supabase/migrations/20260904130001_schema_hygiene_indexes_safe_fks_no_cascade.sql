-- Batch 1 schema hygiene: indexes, safe FKs (orphan-free on TEST+PROD),
-- and stop CASCADE deletes from wiping payment_dispute_events / bill_edit_audit.

-- ── 1. Missing indexes ───────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS khata_transactions_vendor_id_idx
  ON public.khata_transactions (vendor_id);

CREATE INDEX IF NOT EXISTS khata_transactions_user_phone_idx
  ON public.khata_transactions (user_phone);

CREATE INDEX IF NOT EXISTS order_bills_vendor_id_idx
  ON public.order_bills (vendor_id);

CREATE INDEX IF NOT EXISTS referrals_referrer_vendor_id_idx
  ON public.referrals (referrer_vendor_id);

CREATE INDEX IF NOT EXISTS fcm_delivery_log_target_phone_idx
  ON public.fcm_delivery_log (target_phone)
  WHERE target_phone IS NOT NULL;

-- ── 2. FKs only where both TEST and PROD had zero orphans ──────────────────
-- Skipped (orphans on TEST): upi_change_alerts.vendor_id (90),
--   vendor_call_outcomes.request_id (2).

ALTER TABLE public.support_messages
  DROP CONSTRAINT IF EXISTS support_messages_vendor_id_fkey;

ALTER TABLE public.support_messages
  ADD CONSTRAINT support_messages_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors (id)
  ON DELETE SET NULL;

ALTER TABLE public.recurring_orders
  DROP CONSTRAINT IF EXISTS recurring_orders_last_request_id_fkey;

ALTER TABLE public.recurring_orders
  ADD CONSTRAINT recurring_orders_last_request_id_fkey
  FOREIGN KEY (last_request_id) REFERENCES public.requests (id)
  ON DELETE SET NULL;

-- vendors.user_id: all NULL on both envs; historical Auth UUID link.
ALTER TABLE public.vendors
  DROP CONSTRAINT IF EXISTS vendors_user_id_fkey;

ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id)
  ON DELETE SET NULL;

-- ── 3. Financial/audit FKs: CASCADE → NO ACTION ────────────────────────────

ALTER TABLE public.payment_dispute_events
  DROP CONSTRAINT IF EXISTS payment_dispute_events_request_id_fkey;

ALTER TABLE public.payment_dispute_events
  ADD CONSTRAINT payment_dispute_events_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.requests (id)
  ON DELETE NO ACTION;

ALTER TABLE public.payment_dispute_events
  DROP CONSTRAINT IF EXISTS payment_dispute_events_vendor_id_fkey;

ALTER TABLE public.payment_dispute_events
  ADD CONSTRAINT payment_dispute_events_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors (id)
  ON DELETE NO ACTION;

ALTER TABLE public.bill_edit_audit
  DROP CONSTRAINT IF EXISTS bill_edit_audit_bill_id_fkey;

ALTER TABLE public.bill_edit_audit
  ADD CONSTRAINT bill_edit_audit_bill_id_fkey
  FOREIGN KEY (bill_id) REFERENCES public.order_bills (id)
  ON DELETE NO ACTION;

ALTER TABLE public.bill_edit_audit
  DROP CONSTRAINT IF EXISTS bill_edit_audit_vendor_id_fkey;

ALTER TABLE public.bill_edit_audit
  ADD CONSTRAINT bill_edit_audit_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors (id)
  ON DELETE NO ACTION;
