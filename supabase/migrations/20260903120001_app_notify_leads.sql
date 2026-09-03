-- Desktop "Get the App" notify-me captures. Capture-only; no emails sent.
-- Client never writes the table directly (RLS on, no anon policies).
-- Writes go through submit_app_notify_lead (SECURITY DEFINER), same pattern
-- as log_unresolved_search_term.

CREATE TABLE IF NOT EXISTS public.app_notify_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact text NOT NULL,
  contact_kind text NOT NULL CHECK (contact_kind IN ('phone', 'email')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_notify_leads_contact_key UNIQUE (contact)
);

CREATE INDEX IF NOT EXISTS app_notify_leads_created_at_idx
  ON public.app_notify_leads (created_at DESC);

CREATE INDEX IF NOT EXISTS app_notify_leads_kind_idx
  ON public.app_notify_leads (contact_kind);

COMMENT ON TABLE public.app_notify_leads IS
  'Desktop Get-the-App notify-me submissions (phone or email). Capture-only.';

ALTER TABLE public.app_notify_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_notify_leads_service ON public.app_notify_leads;
CREATE POLICY app_notify_leads_service ON public.app_notify_leads
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.submit_app_notify_lead(p_contact text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw text := nullif(trim(coalesce(p_contact, '')), '');
  v_contact text;
  v_kind text;
  v_digits text;
BEGIN
  IF v_raw IS NULL THEN
    RETURN false;
  END IF;

  IF position('@' in v_raw) > 0 THEN
    v_contact := lower(v_raw);
    IF char_length(v_contact) > 254
       OR v_contact !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
      RETURN false;
    END IF;
    v_kind := 'email';
  ELSE
    v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
    IF char_length(v_digits) = 12 AND left(v_digits, 2) = '91' THEN
      v_digits := substring(v_digits from 3);
    END IF;
    IF v_digits !~ '^[6-9][0-9]{9}$' THEN
      RETURN false;
    END IF;
    v_contact := v_digits;
    v_kind := 'phone';
  END IF;

  -- Soft rate limit: drop extras, still report success so the form cannot probe.
  IF (
    SELECT count(*)::integer
    FROM public.app_notify_leads
    WHERE created_at > now() - interval '1 minute'
  ) >= 30 THEN
    RETURN true;
  END IF;

  INSERT INTO public.app_notify_leads (contact, contact_kind)
  VALUES (left(v_contact, 254), v_kind)
  ON CONFLICT (contact) DO NOTHING;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.submit_app_notify_lead(text) IS
  'Insert a Get-the-App notify-me contact (phone or email). Idempotent per contact.';

REVOKE ALL ON FUNCTION public.submit_app_notify_lead(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_app_notify_lead(text)
  TO anon, authenticated, service_role;
