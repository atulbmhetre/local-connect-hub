-- Category-level menus + per-category cancel reasons (account-level fallback kept).
-- Menu: vendor_menu_items.category_id → categories(id) (same convention as requests.category_id).
-- Cancel reasons: vendor_category_cancel_reasons keyed by (vendor_id, category_id)
--   rather than vendor_categories.id, because vendor_update_categories recreates those rows.

-- ── 1. Menu category_id ──────────────────────────────────────────────────────

ALTER TABLE public.vendor_menu_items
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.categories(id);

CREATE INDEX IF NOT EXISTS vendor_menu_items_vendor_category_idx
  ON public.vendor_menu_items (vendor_id, category_id);

COMMENT ON COLUMN public.vendor_menu_items.category_id IS
  'Category this menu item belongs to. NULL only for legacy rows pending backfill.';

-- Best-effort backfill: primary approved vendor_categories, else vendors.category label.
UPDATE public.vendor_menu_items mi
SET category_id = sub.category_id
FROM (
  SELECT DISTINCT ON (vc.vendor_id)
    vc.vendor_id,
    vc.category_id
  FROM public.vendor_categories vc
  WHERE vc.status = 'approved'
  ORDER BY vc.vendor_id, vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
) sub
WHERE mi.vendor_id = sub.vendor_id
  AND mi.category_id IS NULL;

UPDATE public.vendor_menu_items mi
SET category_id = c.id
FROM public.vendors v
JOIN public.categories c ON c.label = v.category
WHERE mi.vendor_id = v.id
  AND mi.category_id IS NULL
  AND v.category IS NOT NULL
  AND btrim(v.category) <> '';

-- ── 2. Per-category cancel reasons ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vendor_category_cancel_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  reason_text text NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, category_id, position)
);

CREATE INDEX IF NOT EXISTS vendor_category_cancel_reasons_vendor_idx
  ON public.vendor_category_cancel_reasons (vendor_id, category_id);

COMMENT ON TABLE public.vendor_category_cancel_reasons IS
  'Up to 4 cancel/decline reasons per vendor category. Empty set falls back to vendors.cancel_reason_1–4.';

ALTER TABLE public.vendor_category_cancel_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vendor_category_cancel_reasons_select"
  ON public.vendor_category_cancel_reasons;
CREATE POLICY "vendor_category_cancel_reasons_select"
  ON public.vendor_category_cancel_reasons
  FOR SELECT
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.vendor_category_cancel_reasons
  FROM anon, authenticated;

-- Seed existing approved categories from account-level reasons (best-effort).
INSERT INTO public.vendor_category_cancel_reasons (vendor_id, category_id, reason_text, position)
SELECT
  vc.vendor_id,
  vc.category_id,
  reason.reason_text,
  reason.position
FROM public.vendor_categories vc
JOIN public.vendors v ON v.id = vc.vendor_id
CROSS JOIN LATERAL (
  VALUES
    (1, NULLIF(btrim(COALESCE(v.cancel_reason_1, '')), '')),
    (2, NULLIF(btrim(COALESCE(v.cancel_reason_2, '')), '')),
    (3, NULLIF(btrim(COALESCE(v.cancel_reason_3, '')), '')),
    (4, NULLIF(btrim(COALESCE(v.cancel_reason_4, '')), ''))
) AS reason(position, reason_text)
WHERE vc.status = 'approved'
  AND reason.reason_text IS NOT NULL
ON CONFLICT (vendor_id, category_id, position) DO NOTHING;

-- ── 3. Helpers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._copy_account_cancel_reasons_to_category(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r1 text;
  v_r2 text;
  v_r3 text;
  v_r4 text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.vendor_category_cancel_reasons
    WHERE vendor_id = p_vendor_id
      AND category_id = p_category_id
  ) THEN
    RETURN;
  END IF;

  SELECT
    NULLIF(btrim(COALESCE(cancel_reason_1, '')), ''),
    NULLIF(btrim(COALESCE(cancel_reason_2, '')), ''),
    NULLIF(btrim(COALESCE(cancel_reason_3, '')), ''),
    NULLIF(btrim(COALESCE(cancel_reason_4, '')), '')
  INTO v_r1, v_r2, v_r3, v_r4
  FROM public.vendors
  WHERE id = p_vendor_id;

  IF v_r1 IS NOT NULL THEN
    INSERT INTO public.vendor_category_cancel_reasons (vendor_id, category_id, reason_text, position)
    VALUES (p_vendor_id, p_category_id, v_r1, 1);
  END IF;
  IF v_r2 IS NOT NULL THEN
    INSERT INTO public.vendor_category_cancel_reasons (vendor_id, category_id, reason_text, position)
    VALUES (p_vendor_id, p_category_id, v_r2, 2);
  END IF;
  IF v_r3 IS NOT NULL THEN
    INSERT INTO public.vendor_category_cancel_reasons (vendor_id, category_id, reason_text, position)
    VALUES (p_vendor_id, p_category_id, v_r3, 3);
  END IF;
  IF v_r4 IS NOT NULL THEN
    INSERT INTO public.vendor_category_cancel_reasons (vendor_id, category_id, reason_text, position)
    VALUES (p_vendor_id, p_category_id, v_r4, 4);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._copy_account_cancel_reasons_to_category(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._vendor_sole_approved_category_id(p_vendor_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN COUNT(*) = 1 THEN (array_agg(vc.category_id))[1]
    ELSE NULL
  END
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.status = 'approved';
$$;

REVOKE ALL ON FUNCTION public._vendor_sole_approved_category_id(uuid) FROM PUBLIC;

-- ── 4. vendor_update_categories: copy reasons for newly added categories ─────

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[]
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

  SELECT v.shop_name
  INTO v_shop_name
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  v_needs_review := v_cat_count >= 3;

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id;

  FOR i IN 1..v_cat_count LOOP
    INSERT INTO public.vendor_categories (
      vendor_id,
      category_id,
      is_primary,
      status,
      needs_review,
      service_mode
    )
    VALUES (
      p_vendor_id,
      p_category_ids[i],
      i = 1,
      'approved',
      v_needs_review,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), 'help')
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

REVOKE ALL ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[])
  TO anon, authenticated;

-- ── 5. Menu RPCs: accept / auto-assign category_id ───────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_insert_menu_items(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_sole uuid;
  v_cat uuid;
BEGIN
  IF p_vendor_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_sole := public._vendor_sole_approved_category_id(p_vendor_id);

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_cat := NULLIF(v_item->>'category_id', '')::uuid;
    IF v_cat IS NULL THEN
      v_cat := v_sole;
    END IF;

    IF v_cat IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.category_id = v_cat
        AND vc.status = 'approved'
    ) THEN
      RAISE EXCEPTION 'invalid_menu_category';
    END IF;

    INSERT INTO public.vendor_menu_items (
      vendor_id,
      name,
      price,
      unit,
      description,
      sort_order,
      is_available,
      category_id
    )
    VALUES (
      p_vendor_id,
      COALESCE(v_item->>'name', ''),
      COALESCE((v_item->>'price')::numeric, 0),
      NULLIF(v_item->>'unit', ''),
      NULLIF(v_item->>'description', ''),
      COALESCE((v_item->>'sort_order')::integer, 0),
      COALESCE((v_item->>'is_available')::boolean, true),
      v_cat
    );
  END LOOP;
END;
$$;

-- Drop old 7-arg overload so PostgREST resolves the new optional category param.
DROP FUNCTION IF EXISTS public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text);

CREATE OR REPLACE FUNCTION public.vendor_update_menu_item(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid,
  p_name text,
  p_price numeric,
  p_unit text,
  p_description text,
  p_category_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sole uuid;
  v_cat uuid;
BEGIN
  IF p_vendor_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_sole := public._vendor_sole_approved_category_id(p_vendor_id);
  v_cat := COALESCE(p_category_id, v_sole);

  IF v_cat IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = v_cat
      AND vc.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'invalid_menu_category';
  END IF;

  UPDATE public.vendor_menu_items mi
  SET
    name = p_name,
    price = p_price,
    unit = NULLIF(p_unit, ''),
    description = NULLIF(p_description, ''),
    category_id = COALESCE(v_cat, mi.category_id)
  FROM public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

GRANT EXECUTE ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid)
  TO anon, authenticated;

-- ── 6. Upsert category cancel reasons ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_upsert_category_cancel_reasons(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_reasons text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i integer;
  v_text text;
BEGIN
  IF p_vendor_phone IS NULL OR btrim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = btrim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_category_id
      AND vc.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'invalid_category';
  END IF;

  DELETE FROM public.vendor_category_cancel_reasons
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  FOR i IN 1..LEAST(4, COALESCE(array_length(p_reasons, 1), 0)) LOOP
    v_text := NULLIF(btrim(COALESCE(p_reasons[i], '')), '');
    IF v_text IS NOT NULL THEN
      INSERT INTO public.vendor_category_cancel_reasons (
        vendor_id, category_id, reason_text, position
      ) VALUES (
        p_vendor_id, p_category_id, left(v_text, 60), i
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_upsert_category_cancel_reasons(uuid, text, uuid, text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_upsert_category_cancel_reasons(uuid, text, uuid, text[])
  TO anon, authenticated;
