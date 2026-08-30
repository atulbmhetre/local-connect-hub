-- Vendor-keyed Exotel call outcomes from StatusCallback (answer-rate later).
-- Written only by service_role (exotel-call-status edge function).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE TABLE IF NOT EXISTS public.vendor_call_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid REFERENCES public.requests(id) ON DELETE SET NULL,
  vendor_phone text NOT NULL,
  call_sid text UNIQUE,
  status text NOT NULL
    CHECK (status IN ('completed', 'failed', 'busy', 'no-answer', 'canceled', 'unknown')),
  duration_seconds integer,
  conversation_duration_seconds integer,
  custom_field text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_call_outcomes_vendor_phone_created_idx
  ON public.vendor_call_outcomes (vendor_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS vendor_call_outcomes_request_id_idx
  ON public.vendor_call_outcomes (request_id)
  WHERE request_id IS NOT NULL;

ALTER TABLE public.vendor_call_outcomes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_call_outcomes FROM anon, authenticated, public;
GRANT ALL ON TABLE public.vendor_call_outcomes TO service_role;

COMMENT ON TABLE public.vendor_call_outcomes IS
  'Exotel Calls/connect terminal StatusCallback rows. No UI yet; queryable for vendor answer-rate.';
