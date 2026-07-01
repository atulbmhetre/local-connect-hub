-- OTP-off production gaps: SECURITY DEFINER RPCs for mutations blocked by auth_user_phone() RLS.

-- ── Fix 1: upsert_app_user ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_app_user(
  p_phone text,
  p_lang text DEFAULT 'en'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.users (phone, last_active)
  VALUES (v_phone, now())
  ON CONFLICT (phone) DO UPDATE
  SET last_active = EXCLUDED.last_active;

  IF p_lang IS NOT NULL AND p_lang IN ('en', 'hi', 'mr') THEN
    UPDATE public.app_users
    SET lang = p_lang
    WHERE phone = v_phone;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_app_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_app_user(text, text) TO anon, authenticated;
