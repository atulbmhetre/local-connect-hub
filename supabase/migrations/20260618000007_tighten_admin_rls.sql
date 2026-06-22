-- Block direct anon writes to admin-only columns; admin RPCs set app.via_admin_rpc for the transaction.

CREATE OR REPLACE FUNCTION public._admin_guard_bypassed()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT current_setting('app.via_admin_rpc', true) = 'true'
      OR current_setting('app.via_system_rpc', true) = 'true'
      OR coalesce(auth.role(), '') = 'service_role';
$$;

CREATE OR REPLACE FUNCTION public.prevent_direct_admin_column_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public._admin_guard_bypassed() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'vendors' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_banned IS DISTINCT FROM OLD.is_banned
       OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason
       OR NEW.is_manual_verified IS DISTINCT FROM OLD.is_manual_verified THEN
      RAISE EXCEPTION 'direct admin column write blocked on vendors';
    END IF;

  ELSIF TG_TABLE_NAME = 'users' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_banned IS DISTINCT FROM OLD.is_banned
       OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason
       OR NEW.warn_count IS DISTINCT FROM OLD.warn_count
       OR NEW.trust_score IS DISTINCT FROM OLD.trust_score THEN
      RAISE EXCEPTION 'direct admin column write blocked on users';
    END IF;

  ELSIF TG_TABLE_NAME = 'categories' AND TG_OP = 'UPDATE' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.pending_review IS DISTINCT FROM OLD.pending_review
       OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'direct admin column write blocked on categories';
    END IF;

  ELSIF TG_TABLE_NAME = 'app_config' AND TG_OP = 'UPDATE' THEN
    IF NEW.value IS DISTINCT FROM OLD.value THEN
      RAISE EXCEPTION 'direct app_config value write blocked';
    END IF;

  ELSIF TG_TABLE_NAME = 'app_config' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'direct app_config insert blocked';

  ELSIF TG_TABLE_NAME = 'vendor_verification' AND TG_OP = 'INSERT' THEN
    IF NEW.check_type = 'admin_check' AND NEW.checked_by = 'admin' THEN
      RAISE EXCEPTION 'direct admin_check insert blocked on vendor_verification';
    END IF;

  ELSIF TG_TABLE_NAME = 'vendor_verification' AND TG_OP = 'UPDATE' THEN
    IF OLD.check_type = 'admin_check' OR NEW.check_type = 'admin_check' THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR NEW.is_latest IS DISTINCT FROM OLD.is_latest
         OR NEW.checked_by IS DISTINCT FROM OLD.checked_by THEN
        RAISE EXCEPTION 'direct admin_check update blocked on vendor_verification';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'vendor_reviews' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct vendor_reviews delete blocked';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_vendors ON public.vendors;
CREATE TRIGGER trg_prevent_direct_admin_vendors
  BEFORE UPDATE ON public.vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_users ON public.users;
CREATE TRIGGER trg_prevent_direct_admin_users
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_categories ON public.categories;
CREATE TRIGGER trg_prevent_direct_admin_categories
  BEFORE UPDATE ON public.categories
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_app_config_update ON public.app_config;
CREATE TRIGGER trg_prevent_direct_admin_app_config_update
  BEFORE UPDATE ON public.app_config
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_app_config_insert ON public.app_config;
CREATE TRIGGER trg_prevent_direct_admin_app_config_insert
  BEFORE INSERT ON public.app_config
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_vendor_verification_insert ON public.vendor_verification;
CREATE TRIGGER trg_prevent_direct_admin_vendor_verification_insert
  BEFORE INSERT ON public.vendor_verification
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_vendor_verification_update ON public.vendor_verification;
CREATE TRIGGER trg_prevent_direct_admin_vendor_verification_update
  BEFORE UPDATE ON public.vendor_verification
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

DROP TRIGGER IF EXISTS trg_prevent_direct_admin_vendor_reviews_delete ON public.vendor_reviews;
CREATE TRIGGER trg_prevent_direct_admin_vendor_reviews_delete
  BEFORE DELETE ON public.vendor_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_direct_admin_column_writes();

-- System definer paths that legitimately touch admin columns
CREATE OR REPLACE FUNCTION public.anonymise_deleted_accounts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  original_phone text;
  anon_tag text;
  v_vendor_id uuid;
BEGIN
  FOR rec IN
    SELECT u.phone
    FROM public.users u
    WHERE u.deletion_requested_at IS NOT NULL
      AND NOT starts_with(u.phone, 'deleted_')
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;

  FOR rec IN
    SELECT v.phone
    FROM public.vendors v
    WHERE v.deletion_requested_at IS NOT NULL
      AND NOT starts_with(v.phone, 'deleted_')
      AND v.deletion_requested_at < now() - interval '30 days'
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

    PERFORM set_config('app.via_system_rpc', 'true', true);

    UPDATE public.vendors
    SET
      phone = anon_tag,
      name = 'Deleted Vendor',
      shop_name = 'Deleted Shop',
      upi_id = NULL,
      fcm_token = NULL,
      latitude = NULL,
      longitude = NULL,
      is_active = false,
      is_banned = true,
      ban_reason = 'Account deleted',
      shop_photo_url = NULL,
      photo_selfie = NULL,
      vendor_note = NULL,
      cancel_reason_1 = NULL,
      cancel_reason_2 = NULL,
      cancel_reason_3 = NULL,
      cancel_reason_4 = NULL,
      referral_code = NULL,
      ledger_cycle_start = NULL
    WHERE phone = original_phone;

    SELECT v.id
    INTO v_vendor_id
    FROM public.vendors v
    WHERE v.phone = anon_tag;

    IF v_vendor_id IS NOT NULL THEN
      DELETE FROM public.vendor_menu_items WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_credits WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_categories WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_verification WHERE vendor_id = v_vendor_id;

      UPDATE public.categories
      SET suggested_by_vendor_id = NULL
      WHERE suggested_by_vendor_id = v_vendor_id;
    END IF;

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    DELETE FROM public.user_devices
    WHERE user_phone = original_phone;

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;

    UPDATE public.vendors
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;
END;
$$;

-- Admin RPCs: set session flag before mutating guarded columns
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
  PERFORM set_config('app.via_admin_rpc', 'true', true);
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
