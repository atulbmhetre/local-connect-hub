-- Phase A: OTP capture table for dormant SMS hook infrastructure tests (TEST only usage).
-- Not used by app code; service role + edge function only.

CREATE TABLE IF NOT EXISTS public._test_otp_capture (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  otp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS _test_otp_capture_phone_created_idx
  ON public._test_otp_capture (phone, created_at DESC);

ALTER TABLE public._test_otp_capture ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public._test_otp_capture FROM anon, authenticated, public;
GRANT ALL ON TABLE public._test_otp_capture TO service_role;

COMMENT ON TABLE public._test_otp_capture IS
  'Temporary OTP capture for phone-auth infrastructure tests. Dormant sms-hook writes here.';
