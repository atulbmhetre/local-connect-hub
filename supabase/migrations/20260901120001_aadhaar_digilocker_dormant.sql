-- Dormant Aadhaar/DigiLocker (Decentro) — Razorpay-style two-layer gate.
-- Client: app_config.aadhaar_verification_enabled default false (coming-soon).
-- Edge: compile-time AADHAAR_VERIFICATION_ENABLED=false; going live needs a redeploy.
-- Do not add Aadhaar columns to vendors. Do not put Decentro ids in
-- vendor_verification.notes (publicly readable). Success/failure is written
-- later via _upsert_vendor_verification_status(..., 'aadhaar_digilocker', ...).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

-- ── client flag ────────────────────────────────────────────────────────────
SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value)
VALUES ('aadhaar_verification_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
RESET app.via_admin_rpc;

-- ── service-role ledger: our reference_id + Decentro txn ids only ────────────
CREATE TABLE IF NOT EXISTS public.vendor_aadhaar_digilocker_txns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  reference_id text NOT NULL,
  decentro_txn_id text NULL,
  eaadhaar_decentro_txn_id text NULL,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'passed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT vendor_aadhaar_digilocker_txns_reference_id_unique UNIQUE (reference_id)
);

COMMENT ON TABLE public.vendor_aadhaar_digilocker_txns IS
  'Service-role only. Stores Decentro DigiLocker session ids. Never XML/PDF/name/DOB/Aadhaar.';

COMMENT ON COLUMN public.vendor_aadhaar_digilocker_txns.reference_id IS
  'Our unique id sent to Decentro as reference_id.';

COMMENT ON COLUMN public.vendor_aadhaar_digilocker_txns.decentro_txn_id IS
  'Initiate-session decentroTxnId; passed later as initial_decentro_transaction_id.';

COMMENT ON COLUMN public.vendor_aadhaar_digilocker_txns.eaadhaar_decentro_txn_id IS
  'eaadhaar response decentroTxnId. No document body is stored.';

CREATE INDEX IF NOT EXISTS vendor_aadhaar_digilocker_txns_vendor_id_idx
  ON public.vendor_aadhaar_digilocker_txns (vendor_id, created_at DESC);

ALTER TABLE public.vendor_aadhaar_digilocker_txns ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_aadhaar_digilocker_txns FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_aadhaar_digilocker_txns FROM anon, authenticated;
GRANT ALL ON TABLE public.vendor_aadhaar_digilocker_txns TO service_role;

GRANT EXECUTE ON FUNCTION public._upsert_vendor_verification_status(uuid, text, text, text)
  TO service_role;
