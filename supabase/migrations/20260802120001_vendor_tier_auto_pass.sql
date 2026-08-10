-- Auto-pass Bronze-tier vendor_verification checks from existing vendor data.
-- Convention (flag for Atul): photo_shop / gps use ANY category that qualifies
-- (account-level vendor_verification rows; multi-category = pass if at least one
-- business has a valid non-soft-fail photo / in-tolerance GPS match).
-- Does NOT touch upi_pennydrop, aadhaar_digilocker, admin_check, or upi_format.

CREATE OR REPLACE FUNCTION public._upsert_vendor_verification_status(
  p_vendor_id uuid,
  p_check_type text,
  p_status text,
  p_checked_by text DEFAULT 'system'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current text;
BEGIN
  IF p_status NOT IN ('passed', 'failed', 'pending', 'dormant') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;

  SELECT vv.status
  INTO v_current
  FROM public.vendor_verification vv
  WHERE vv.vendor_id = p_vendor_id
    AND vv.check_type = p_check_type
    AND vv.is_latest = true
  LIMIT 1;

  IF v_current IS NOT DISTINCT FROM p_status THEN
    RETURN;
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
  VALUES (p_vendor_id, p_check_type, p_status, p_checked_by, true);
END;
$$;

COMMENT ON FUNCTION public._upsert_vendor_verification_status(uuid, text, text, text) IS
  'Internal: append vendor_verification row only when latest status changes.';

REVOKE ALL ON FUNCTION public._upsert_vendor_verification_status(uuid, text, text, text) FROM PUBLIC;

-- Mirror src/lib/gpsMatch.ts gpsEffectiveTolerance: max(75, loc_acc + photo_acc).
CREATE OR REPLACE FUNCTION public.sync_vendor_tier_auto_checks(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_selfie boolean := false;
  v_photo_shop_ok boolean := false;
  v_gps_ok boolean := false;
BEGIN
  IF p_vendor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    v.photo_selfie IS NOT NULL AND trim(v.photo_selfie) <> ''
  INTO v_has_selfie
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- ANY category with a real shop photo, excluding soft-fail pending review.
  SELECT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.shop_photo_url IS NOT NULL
      AND trim(vc.shop_photo_url) <> ''
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
  )
  INTO v_photo_shop_ok;

  -- ANY category with in-tolerance GPS match, excluding soft-fail.
  SELECT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.gps_match_distance IS NOT NULL
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
      AND vc.gps_match_distance::double precision
        <= GREATEST(
          75.0,
          COALESCE(vc.location_accuracy, 0)::double precision
            + COALESCE(vc.photo_accuracy, 0)::double precision
        )
  )
  INTO v_gps_ok;

  PERFORM public._upsert_vendor_verification_status(
    p_vendor_id,
    'photo_selfie',
    CASE WHEN v_has_selfie THEN 'passed' ELSE 'dormant' END,
    'system'
  );

  PERFORM public._upsert_vendor_verification_status(
    p_vendor_id,
    'photo_shop',
    CASE WHEN v_photo_shop_ok THEN 'passed' ELSE 'dormant' END,
    'system'
  );

  PERFORM public._upsert_vendor_verification_status(
    p_vendor_id,
    'gps',
    CASE WHEN v_gps_ok THEN 'passed' ELSE 'dormant' END,
    'system'
  );
END;
$$;

COMMENT ON FUNCTION public.sync_vendor_tier_auto_checks(uuid) IS
  'Auto-pass photo_selfie / photo_shop / gps from vendor data (any qualifying category). Soft-fail pending_location_review excluded.';

REVOKE ALL ON FUNCTION public.sync_vendor_tier_auto_checks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_vendor_tier_auto_checks(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_vendors_sync_tier_auto_checks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_vendor_tier_auto_checks(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendors_sync_tier_auto_checks ON public.vendors;
CREATE TRIGGER vendors_sync_tier_auto_checks
  AFTER INSERT OR UPDATE OF photo_selfie
  ON public.vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_vendors_sync_tier_auto_checks();

CREATE OR REPLACE FUNCTION public.trg_vendor_categories_sync_tier_auto_checks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_vendor_tier_auto_checks(NEW.vendor_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_categories_sync_tier_auto_checks ON public.vendor_categories;
CREATE TRIGGER vendor_categories_sync_tier_auto_checks
  AFTER INSERT OR UPDATE OF shop_photo_url, gps_match_distance, verification_status,
    location_accuracy, photo_accuracy
  ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_vendor_categories_sync_tier_auto_checks();

-- submit_vendor_verification: for photo_selfie, sync to passed/dormant from vendors row
-- instead of leaving a permanent "pending" that never becomes passed.
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

  -- Auto-managed Bronze checks: refresh from source data (do not force pending).
  IF p_check_type IN ('photo_selfie', 'photo_shop', 'gps') THEN
    PERFORM public.sync_vendor_tier_auto_checks(p_vendor_id);
    RETURN;
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

COMMENT ON FUNCTION public.submit_vendor_verification(uuid, text, text, text) IS
  'Vendor verification submit. photo_selfie/photo_shop/gps sync from source data; other types insert pending.';

-- One-time backfill for existing vendors (TEST/PROD when applied).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.vendors LOOP
    PERFORM public.sync_vendor_tier_auto_checks(r.id);
  END LOOP;
END;
$$;
