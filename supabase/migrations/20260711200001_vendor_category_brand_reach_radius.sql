-- Per-category brand name, reach, and service radius on vendor_categories.
-- Account-level vendors.* fields remain the default/fallback.

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS serves_at_vendor_place boolean,
  ADD COLUMN IF NOT EXISTS serves_at_customer_place boolean,
  ADD COLUMN IF NOT EXISTS service_radius_km numeric;

-- Backfill from account-level vendor defaults.
UPDATE public.vendor_categories vc
SET
  brand_name = COALESCE(vc.brand_name, NULLIF(trim(v.shop_name), '')),
  serves_at_vendor_place = COALESCE(vc.serves_at_vendor_place, v.serves_at_vendor_place),
  serves_at_customer_place = COALESCE(vc.serves_at_customer_place, v.serves_at_customer_place),
  service_radius_km = COALESCE(vc.service_radius_km, v.service_radius_km)
FROM public.vendors v
WHERE vc.vendor_id = v.id;

-- At least one reach flag must be true when both are set (same rule as vendors).
ALTER TABLE public.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_reach_chk;

ALTER TABLE public.vendor_categories
  ADD CONSTRAINT vendor_categories_reach_chk
  CHECK (
    serves_at_vendor_place IS NULL
    OR serves_at_customer_place IS NULL
    OR serves_at_vendor_place = true
    OR serves_at_customer_place = true
  );

COMMENT ON COLUMN public.vendor_categories.brand_name IS
  'Category-specific brand/shop display name; falls back to vendors.shop_name when null.';
COMMENT ON COLUMN public.vendor_categories.serves_at_vendor_place IS
  'Category reach: customers come to vendor. Null inherits vendors.serves_at_vendor_place.';
COMMENT ON COLUMN public.vendor_categories.serves_at_customer_place IS
  'Category reach: vendor goes to customer. Null inherits vendors.serves_at_customer_place.';
COMMENT ON COLUMN public.vendor_categories.service_radius_km IS
  'Category service radius when serving at customer place. Null inherits vendors.service_radius_km.';

-- ── vendor_update_categories: accept per-category brand/reach/radius ─────────

DROP FUNCTION IF EXISTS public.vendor_update_categories(uuid, text, uuid[], text[]);

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[],
  p_brand_names text[] DEFAULT NULL,
  p_serves_at_vendor_place boolean[] DEFAULT NULL,
  p_serves_at_customer_place boolean[] DEFAULT NULL,
  p_service_radius_km numeric[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cat_count integer;
  v_needs_review boolean;
  i integer;
  v_old_ids uuid[];
  v_removed uuid[];
  v_added uuid[];
  v_shop_name text;
  v_new_id uuid;
  v_acct_brand text;
  v_acct_vendor_place boolean;
  v_acct_customer_place boolean;
  v_acct_radius numeric;
  v_brand text;
  v_vendor_place boolean;
  v_customer_place boolean;
  v_radius numeric;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors
    WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);
  IF v_cat_count = 0 THEN
    RAISE EXCEPTION 'category_ids_required';
  END IF;

  IF p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  IF p_brand_names IS NOT NULL
    AND COALESCE(array_length(p_brand_names, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'brand_names length must match category_ids length';
  END IF;
  IF p_serves_at_vendor_place IS NOT NULL
    AND COALESCE(array_length(p_serves_at_vendor_place, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'serves_at_vendor_place length must match category_ids length';
  END IF;
  IF p_serves_at_customer_place IS NOT NULL
    AND COALESCE(array_length(p_serves_at_customer_place, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'serves_at_customer_place length must match category_ids length';
  END IF;
  IF p_service_radius_km IS NOT NULL
    AND COALESCE(array_length(p_service_radius_km, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'service_radius_km length must match category_ids length';
  END IF;

  SELECT COALESCE(array_agg(vc.category_id), ARRAY[]::uuid[])
  INTO v_old_ids
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id;

  SELECT COALESCE(array_agg(old_id), ARRAY[]::uuid[])
  INTO v_removed
  FROM unnest(v_old_ids) AS old_id
  WHERE NOT (old_id = ANY (p_category_ids));

  SELECT COALESCE(array_agg(new_id), ARRAY[]::uuid[])
  INTO v_added
  FROM unnest(p_category_ids) AS new_id
  WHERE NOT (new_id = ANY (v_old_ids));

  SELECT
    v.shop_name,
    COALESCE(v.serves_at_vendor_place, false),
    COALESCE(v.serves_at_customer_place, true),
    v.service_radius_km
  INTO v_shop_name, v_acct_vendor_place, v_acct_customer_place, v_acct_radius
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  v_acct_brand := NULLIF(trim(COALESCE(v_shop_name, '')), '');
  v_needs_review := v_cat_count >= 3;

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id;

  FOR i IN 1..v_cat_count LOOP
    v_brand := CASE
      WHEN p_brand_names IS NOT NULL THEN NULLIF(trim(p_brand_names[i]), '')
      ELSE NULL
    END;
    v_vendor_place := CASE
      WHEN p_serves_at_vendor_place IS NOT NULL THEN p_serves_at_vendor_place[i]
      ELSE NULL
    END;
    v_customer_place := CASE
      WHEN p_serves_at_customer_place IS NOT NULL THEN p_serves_at_customer_place[i]
      ELSE NULL
    END;
    v_radius := CASE
      WHEN p_service_radius_km IS NOT NULL THEN p_service_radius_km[i]
      ELSE NULL
    END;

    -- Newly added categories without explicit values inherit account defaults.
    IF v_added IS NOT NULL AND p_category_ids[i] = ANY (v_added) THEN
      v_brand := COALESCE(v_brand, v_acct_brand);
      v_vendor_place := COALESCE(v_vendor_place, v_acct_vendor_place);
      v_customer_place := COALESCE(v_customer_place, v_acct_customer_place);
      v_radius := COALESCE(v_radius, v_acct_radius);
    ELSE
      v_brand := COALESCE(v_brand, v_acct_brand);
      v_vendor_place := COALESCE(v_vendor_place, v_acct_vendor_place);
      v_customer_place := COALESCE(v_customer_place, v_acct_customer_place);
      v_radius := COALESCE(v_radius, v_acct_radius);
    END IF;

    IF NOT COALESCE(v_vendor_place, false) AND NOT COALESCE(v_customer_place, false) THEN
      RAISE EXCEPTION 'category_reach_required';
    END IF;

    INSERT INTO public.vendor_categories (
      vendor_id,
      category_id,
      is_primary,
      status,
      needs_review,
      service_mode,
      brand_name,
      serves_at_vendor_place,
      serves_at_customer_place,
      service_radius_km
    )
    VALUES (
      p_vendor_id,
      p_category_ids[i],
      i = 1,
      'approved',
      v_needs_review,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), 'help'),
      v_brand,
      v_vendor_place,
      v_customer_place,
      v_radius
    );
  END LOOP;

  IF COALESCE(array_length(v_removed, 1), 0) > 0 THEN
    PERFORM public._purge_saved_vendors_for_removed_categories(
      p_vendor_id,
      v_removed,
      v_shop_name
    );

    DELETE FROM public.vendor_category_cancel_reasons
    WHERE vendor_id = p_vendor_id
      AND category_id = ANY (v_removed);
  END IF;

  IF COALESCE(array_length(v_added, 1), 0) > 0 THEN
    FOREACH v_new_id IN ARRAY v_added
    LOOP
      PERFORM public._copy_account_cancel_reasons_to_category(p_vendor_id, v_new_id);
    END LOOP;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], text[], boolean[], boolean[], numeric[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_categories(
  uuid, text, uuid[], text[], text[], boolean[], boolean[], numeric[]
) TO anon, authenticated;

-- Inherit account defaults on any insert path (register_vendor, attach_pending, etc.).
CREATE OR REPLACE FUNCTION public._vendor_categories_inherit_account_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop text;
  v_vendor_place boolean;
  v_customer_place boolean;
  v_radius numeric;
BEGIN
  SELECT
    NULLIF(trim(COALESCE(v.shop_name, '')), ''),
    COALESCE(v.serves_at_vendor_place, false),
    COALESCE(v.serves_at_customer_place, true),
    v.service_radius_km
  INTO v_shop, v_vendor_place, v_customer_place, v_radius
  FROM public.vendors v
  WHERE v.id = NEW.vendor_id;

  IF NEW.brand_name IS NULL OR trim(NEW.brand_name) = '' THEN
    NEW.brand_name := v_shop;
  END IF;
  IF NEW.serves_at_vendor_place IS NULL THEN
    NEW.serves_at_vendor_place := v_vendor_place;
  END IF;
  IF NEW.serves_at_customer_place IS NULL THEN
    NEW.serves_at_customer_place := v_customer_place;
  END IF;
  IF NEW.service_radius_km IS NULL THEN
    NEW.service_radius_km := v_radius;
  END IF;

  IF NOT COALESCE(NEW.serves_at_vendor_place, false)
    AND NOT COALESCE(NEW.serves_at_customer_place, false)
  THEN
    NEW.serves_at_customer_place := true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_categories_inherit_defaults ON public.vendor_categories;
CREATE TRIGGER trg_vendor_categories_inherit_defaults
  BEFORE INSERT ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public._vendor_categories_inherit_account_defaults();
