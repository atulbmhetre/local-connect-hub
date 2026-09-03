-- payment_dispute_events / customer_payment_restrictions: financial identity
-- data created without RLS. Anon SELECT/INSERT succeeded on live TEST/PROD
-- (INSERT only failed on NOT NULL). RPC-only, matching support_messages /
-- app_notify_leads / vendor_call_outcomes.

ALTER TABLE public.payment_dispute_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_payment_restrictions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_dispute_events FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_dispute_events FROM anon, authenticated;
GRANT ALL ON TABLE public.payment_dispute_events TO service_role;

REVOKE ALL ON TABLE public.customer_payment_restrictions FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_payment_restrictions FROM anon, authenticated;
GRANT ALL ON TABLE public.customer_payment_restrictions TO service_role;

DROP POLICY IF EXISTS payment_dispute_events_service ON public.payment_dispute_events;
CREATE POLICY payment_dispute_events_service ON public.payment_dispute_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS customer_payment_restrictions_service ON public.customer_payment_restrictions;
CREATE POLICY customer_payment_restrictions_service ON public.customer_payment_restrictions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.payment_dispute_events IS
  'Immutable log of vendor-disputed UPI payment claims. Written only via dispute_upi_payment (SECURITY DEFINER). No direct client access.';

COMMENT ON TABLE public.customer_payment_restrictions IS
  'Cash-only backstop after disputes. Written only via SECURITY DEFINER RPCs. No direct client access.';
