-- Add the two FKs deferred in 20260904130001 after TEST fixture cleanup
-- cleared orphans (upi_change_alerts.vendor_id: 90 → 0;
-- vendor_call_outcomes.request_id: 2 → 0). Re-verified zero orphans on
-- TEST + PROD immediately before this migration.
--
-- vendor_call_outcomes.request_id: ON DELETE SET NULL — outcomes must survive
-- request deletion (see 20260829161001). Column is nullable.
-- upi_change_alerts.vendor_id: ON DELETE NO ACTION — alert rows are audit;
-- vendor_id is NOT NULL (cannot SET NULL).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

DO $$
DECLARE
  v_upi_orphans integer;
  v_call_orphans integer;
BEGIN
  SELECT count(*)::integer
  INTO v_upi_orphans
  FROM public.upi_change_alerts a
  LEFT JOIN public.vendors v ON v.id = a.vendor_id
  WHERE a.vendor_id IS NOT NULL AND v.id IS NULL;

  SELECT count(*)::integer
  INTO v_call_orphans
  FROM public.vendor_call_outcomes o
  LEFT JOIN public.requests r ON r.id = o.request_id
  WHERE o.request_id IS NOT NULL AND r.id IS NULL;

  IF v_upi_orphans <> 0 OR v_call_orphans <> 0 THEN
    RAISE EXCEPTION
      'refusing deferred FKs: upi_orphans=% call_orphans=% (must both be 0)',
      v_upi_orphans, v_call_orphans;
  END IF;
END $$;

ALTER TABLE public.upi_change_alerts
  DROP CONSTRAINT IF EXISTS upi_change_alerts_vendor_id_fkey;

ALTER TABLE public.upi_change_alerts
  ADD CONSTRAINT upi_change_alerts_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors (id)
  ON DELETE NO ACTION;

ALTER TABLE public.vendor_call_outcomes
  DROP CONSTRAINT IF EXISTS vendor_call_outcomes_request_id_fkey;

ALTER TABLE public.vendor_call_outcomes
  ADD CONSTRAINT vendor_call_outcomes_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.requests (id)
  ON DELETE SET NULL;

COMMENT ON CONSTRAINT upi_change_alerts_vendor_id_fkey ON public.upi_change_alerts IS
  'Deferred from 20260904130001; added after TEST orphan cleanup. ON DELETE NO ACTION (audit).';

COMMENT ON CONSTRAINT vendor_call_outcomes_request_id_fkey ON public.vendor_call_outcomes IS
  'Re-added after orphan cleanup. ON DELETE SET NULL so outcomes survive request deletion.';
