-- Enable RLS on notification_i18n: public SELECT only (matches categories/app_config pattern).
-- Writes remain migration/service-role only; no INSERT/UPDATE/DELETE policies for anon/authenticated.

ALTER TABLE public.notification_i18n ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_i18n_public_read ON public.notification_i18n;

CREATE POLICY notification_i18n_public_read ON public.notification_i18n
  FOR SELECT
  TO anon, authenticated
  USING (true);
