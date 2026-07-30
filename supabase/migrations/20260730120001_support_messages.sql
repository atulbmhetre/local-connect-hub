-- Durable store for Help & Support Feedback / Contact submissions.
-- Client never writes directly (RLS on, no policies). Edge function uses service role.
-- Email delivery (Resend) is attempted by send-support-email when RESEND_API_KEY is set.

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('feedback', 'contact')),
  category text,
  rating integer CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  message text NOT NULL,
  user_phone text,
  vendor_id uuid,
  device_id text,
  email_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_messages_created_at_idx
  ON public.support_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS support_messages_kind_idx
  ON public.support_messages (kind);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.support_messages IS
  'Help & Support Feedback/Contact submissions. Written only by send-support-email edge function.';
