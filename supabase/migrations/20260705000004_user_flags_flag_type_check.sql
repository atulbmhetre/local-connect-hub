-- Align TEST (and any env missing this constraint) with PROD's user_flags.flag_type rule.
-- PROD already has user_flags_flag_type_check (dashboard-era); this migration is idempotent
-- so re-applying on PROD is a no-op. Canonical values match the app UI and trust-score edge fn:
--   noshow | fake | abusive
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_flags_flag_type_check'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_flag_type_check
      CHECK (flag_type = ANY (ARRAY['noshow'::text, 'fake'::text, 'abusive'::text]));
  END IF;
END $$;
