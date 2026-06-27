-- Admin dashboard alerts for edge-function failures (one open alert per function).

CREATE TABLE public.admin_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  error_type text NOT NULL CHECK (error_type IN ('billing', 'model', 'timeout', 'unknown')),
  raw_error text,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.admin_alerts IS
  'Open/resolved alerts when edge functions fail; at most one unresolved row per function_name.';

COMMENT ON COLUMN public.admin_alerts.function_name IS
  'Edge function that failed (e.g. suggest-category).';

COMMENT ON COLUMN public.admin_alerts.raw_error IS
  'Full error message or response body; callers should truncate to 1000 chars when storing.';

-- One unresolved alert per function — prevents alert spam on repeated failures.
CREATE UNIQUE INDEX admin_alerts_one_open_per_function_idx
  ON public.admin_alerts (function_name)
  WHERE resolved_at IS NULL;

CREATE INDEX admin_alerts_function_name_resolved_at_idx
  ON public.admin_alerts (function_name, resolved_at);

ALTER TABLE public.admin_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON public.admin_alerts;

CREATE POLICY admin_alerts_admin ON public.admin_alerts
  FOR ALL
  TO anon, authenticated
  USING (public.is_admin_phone(public.auth_user_phone()))
  WITH CHECK (public.is_admin_phone(public.auth_user_phone()));
