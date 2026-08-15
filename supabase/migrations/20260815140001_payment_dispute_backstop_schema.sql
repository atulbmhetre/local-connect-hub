-- Section 5c: payment dispute event log + customer payment restriction state.

CREATE TABLE public.payment_dispute_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  user_phone text,
  device_id text,
  disputed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_dispute_events IS
  'Immutable log of vendor-disputed UPI payment claims; one row per dispute_upi_payment call.';

CREATE INDEX payment_dispute_events_identity_phone_idx
  ON public.payment_dispute_events (user_phone, disputed_at DESC)
  WHERE user_phone IS NOT NULL AND btrim(user_phone) <> '';

CREATE INDEX payment_dispute_events_identity_device_idx
  ON public.payment_dispute_events (device_id, disputed_at DESC)
  WHERE device_id IS NOT NULL AND btrim(device_id) <> '';

CREATE INDEX payment_dispute_events_vendor_identity_idx
  ON public.payment_dispute_events (vendor_id, user_phone, device_id);

CREATE TABLE public.customer_payment_restrictions (
  identity_key text PRIMARY KEY,
  is_restricted boolean NOT NULL DEFAULT false,
  restricted_at timestamptz,
  last_dispute_at timestamptz
);

COMMENT ON TABLE public.customer_payment_restrictions IS
  'Cash-only backstop: self-declared digital payment disabled when is_restricted = true.';

CREATE INDEX customer_payment_restrictions_active_idx
  ON public.customer_payment_restrictions (identity_key)
  WHERE is_restricted = true;

-- Derive stable customer identity: phone when present, else device_id.
CREATE OR REPLACE FUNCTION public._customer_payment_identity_key(
  p_user_phone text,
  p_device_id text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(btrim(p_user_phone), ''),
    NULLIF(btrim(p_device_id), '')
  );
$$;

COMMENT ON FUNCTION public._customer_payment_identity_key(text, text) IS
  'Customer payment identity for dispute backstop: user_phone if set, otherwise device_id.';

REVOKE ALL ON FUNCTION public._customer_payment_identity_key(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._customer_payment_identity_key(text, text) TO anon, authenticated, service_role;
