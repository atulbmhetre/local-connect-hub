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

-- ── Fix 2: user_addresses update/delete ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_user_address(
  p_user_phone text,
  p_address_id uuid,
  p_address_text text,
  p_label text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NULLIF(trim(p_address_text), '') IS NULL THEN
    RAISE EXCEPTION 'address_required';
  END IF;

  UPDATE public.user_addresses
  SET
    address_text = trim(p_address_text),
    label = COALESCE(NULLIF(trim(p_label), ''), label)
  WHERE id = p_address_id
    AND user_phone = v_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_user_address(
  p_user_phone text,
  p_address_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  DELETE FROM public.user_addresses
  WHERE id = p_address_id
    AND user_phone = v_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_user_address(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_user_address(text, uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.delete_user_address(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_address(text, uuid) TO anon, authenticated;

-- ── Fix 3: vendor_verification insert (selfie) ───────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_vendor_verification(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_check_type text,
  p_doc_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_vendor_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = p_vendor_id AND v.phone = v_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  UPDATE public.vendor_verification
  SET is_latest = false
  WHERE vendor_id = p_vendor_id
    AND check_type = p_check_type
    AND is_latest = true;

  INSERT INTO public.vendor_verification (
    vendor_id,
    check_type,
    status,
    checked_by,
    is_latest
  )
  VALUES (p_vendor_id, p_check_type, 'pending', 'system', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_vendor_verification(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_vendor_verification(uuid, text, text, text) TO anon, authenticated;
