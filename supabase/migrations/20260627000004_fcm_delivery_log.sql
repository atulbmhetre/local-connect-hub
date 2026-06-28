CREATE TABLE public.fcm_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  notification_type text NOT NULL,
  target_phone text,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  raw_response text
);

COMMENT ON TABLE public.fcm_delivery_log IS 'FCM push notification delivery outcomes — one row per send attempt';

ALTER TABLE public.fcm_delivery_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY fcm_log_admin ON public.fcm_delivery_log
  FOR ALL TO anon, authenticated
  USING (public.is_admin_phone(public.auth_user_phone()))
  WITH CHECK (public.is_admin_phone(public.auth_user_phone()));
