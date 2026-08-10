-- Phase 3: stop account-level auto-pass for photo_shop / gps.
-- Location proof is derived from vendor_categories columns (Phase 3 clients).
-- Historical vendor_verification photo_shop/gps rows are left in place (cleanup later).
-- photo_selfie remains account-level auto-pass.

CREATE OR REPLACE FUNCTION public.sync_vendor_tier_auto_checks(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_selfie boolean := false;
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

  PERFORM public._upsert_vendor_verification_status(
    p_vendor_id,
    'photo_selfie',
    CASE WHEN v_has_selfie THEN 'passed' ELSE 'dormant' END,
    'system'
  );

  -- photo_shop / gps: intentionally not written. Per-business derivation lives in
  -- client trustLevel.computeTrustLevelForBusiness from vendor_categories columns.
END;
$$;

COMMENT ON FUNCTION public.sync_vendor_tier_auto_checks(uuid) IS
  'Auto-pass account photo_selfie only. photo_shop/gps are per-business (vendor_categories).';

-- submit_vendor_verification: photo_shop/gps no longer force account sync as pass path;
-- keep sync call for selfie; for photo_shop/gps just sync selfie (no-op on those checks).
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

  -- Location checks are per-business on vendor_categories; do not write account VV rows.
  IF p_check_type IN ('photo_shop', 'gps') THEN
    RETURN;
  END IF;

  IF p_check_type = 'photo_selfie' THEN
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
  'Vendor verification submit. photo_selfie syncs from vendors; photo_shop/gps ignored (per-business).';
