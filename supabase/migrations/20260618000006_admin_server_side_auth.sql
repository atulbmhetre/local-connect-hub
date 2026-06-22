-- Server-side admin authorization for moderation actions previously gated only in the UI.

CREATE OR REPLACE FUNCTION public.is_admin_phone(p_phone text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(trim(p_phone), '') IS NOT NULL
    AND trim(p_phone) = NULLIF(trim((SELECT value FROM public.app_config WHERE key = 'admin_phone')), '');
$$;

REVOKE ALL ON FUNCTION public.is_admin_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_phone(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_ban_vendor(
  p_admin_phone text,
  p_vendor_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.vendors
  SET is_banned = true,
      ban_reason = NULLIF(trim(p_reason), '')
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unban_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.vendors
  SET is_banned = false,
      ban_reason = null
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_verify_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.vendors
  SET is_manual_verified = true
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unverify_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.vendors
  SET is_manual_verified = false,
      verification_status = CASE
        WHEN verification_status = 'green_pending' THEN 'business_verified'
        ELSE verification_status
      END
  WHERE id = p_vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_category(
  p_admin_phone text,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.categories
  SET is_active = true,
      pending_review = false,
      status = 'active'
  WHERE id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_category(
  p_admin_phone text,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.categories
  SET pending_review = false,
      is_active = false,
      status = 'rejected'
  WHERE id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_review(
  p_admin_phone text,
  p_review_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT vendor_id INTO v_vendor_id
  FROM public.vendor_reviews
  WHERE id = p_review_id;
  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'review not found';
  END IF;
  DELETE FROM public.vendor_reviews WHERE id = p_review_id;
  RETURN v_vendor_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_app_config(
  p_admin_phone text,
  p_key text,
  p_value text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF NULLIF(trim(p_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid key';
  END IF;
  INSERT INTO public.app_config (key, value)
  VALUES (trim(p_key), coalesce(p_value, ''))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_ban_user(
  p_admin_phone text,
  p_user_phone text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.users
  SET is_banned = true,
      ban_reason = NULLIF(trim(p_reason), ''),
      trust_score = 0
  WHERE phone = trim(p_user_phone);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unban_user(
  p_admin_phone text,
  p_user_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.users
  SET is_banned = false,
      ban_reason = null,
      trust_score = 50
  WHERE phone = trim(p_user_phone);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_warn_user(
  p_admin_phone text,
  p_user_phone text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_warn_count integer;
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  UPDATE public.users
  SET warn_count = coalesce(warn_count, 0) + 1,
      last_warned_at = now()
  WHERE phone = trim(p_user_phone)
  RETURNING warn_count INTO v_next_warn_count;
  IF v_next_warn_count IS NULL THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  RETURN v_next_warn_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_vendor_check(
  p_admin_phone text,
  p_vendor_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;
  UPDATE public.vendor_verification
  SET is_latest = false
  WHERE vendor_id = p_vendor_id
    AND check_type = 'admin_check'
    AND is_latest = true;
  INSERT INTO public.vendor_verification (
    vendor_id,
    check_type,
    status,
    checked_by,
    is_latest
  )
  VALUES (p_vendor_id, 'admin_check', p_status, 'admin', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ban_vendor(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unban_vendor(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_verify_vendor(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unverify_vendor(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_category(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reject_category(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_review(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_app_config(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_ban_user(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unban_user(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_warn_user(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_vendor_check(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_ban_vendor(text, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unban_vendor(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_verify_vendor(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unverify_vendor(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_approve_category(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reject_category(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_review(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_app_config(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_ban_user(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unban_user(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_warn_user(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_vendor_check(text, uuid, text) TO anon, authenticated;
