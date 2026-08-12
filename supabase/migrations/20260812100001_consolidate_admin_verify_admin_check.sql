-- Consolidate admin verification: verify/unverify category also sets admin_check
-- in the same transaction (account-level vendor_verification row).

CREATE OR REPLACE FUNCTION public._upsert_vendor_admin_check_status(
  p_vendor_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

REVOKE ALL ON FUNCTION public._upsert_vendor_admin_check_status(uuid, text) FROM PUBLIC;

COMMENT ON FUNCTION public._upsert_vendor_admin_check_status(uuid, text) IS
  'Internal: append latest admin_check row for a vendor (passed/failed).';

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
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  PERFORM public._upsert_vendor_admin_check_status(p_vendor_id, p_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_verify_vendor_category(
  p_admin_phone text,
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT verification_status INTO v_status
  FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF COALESCE(v_status, '') NOT IN (
    'green_pending',
    'business_verified',
    'pending_location_review'
  ) THEN
    RAISE EXCEPTION 'category_not_ready';
  END IF;

  UPDATE public.vendor_categories
  SET
    is_manual_verified = true,
    verification_status = CASE
      WHEN verification_status = 'pending_location_review' THEN 'business_verified'
      ELSE verification_status
    END
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  UPDATE public.vendors v
  SET is_manual_verified = EXISTS (
    SELECT 1 FROM public.vendor_categories vc
    WHERE vc.vendor_id = v.id AND vc.is_manual_verified = true
  )
  WHERE v.id = p_vendor_id;

  PERFORM public._upsert_vendor_admin_check_status(p_vendor_id, 'passed');
END;
$$;

COMMENT ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) IS
  'Admin approval for one business; sets is_manual_verified and admin_check=passed atomically.';

CREATE OR REPLACE FUNCTION public.admin_unverify_vendor_category(
  p_admin_phone text,
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  UPDATE public.vendor_categories
  SET
    is_manual_verified = false,
    verification_status = CASE
      WHEN verification_status = 'green_pending' THEN 'business_verified'
      ELSE verification_status
    END
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  UPDATE public.vendors v
  SET is_manual_verified = EXISTS (
    SELECT 1 FROM public.vendor_categories vc
    WHERE vc.vendor_id = v.id AND vc.is_manual_verified = true
  )
  WHERE v.id = p_vendor_id;

  PERFORM public._upsert_vendor_admin_check_status(p_vendor_id, 'failed');
END;
$$;

COMMENT ON FUNCTION public.admin_unverify_vendor_category(text, uuid, uuid) IS
  'Admin removes per-business verification; sets admin_check=failed atomically.';
