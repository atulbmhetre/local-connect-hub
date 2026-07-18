-- Menu mutation hardening: rate-limit the four vendor menu mutation RPCs.
--
-- Problem: these RPCs authorize only via vendor_id + phone match, and vendor
-- phones are publicly readable — anyone can mutate any discoverable vendor's
-- menu/prices at unlimited speed. Full identity closure is the standing
-- OTP-off/session limitation tracked separately; this applies the same
-- check_and_log_rate_limit pattern used across tonight's hardening
-- (phone-keyed, 30/min per function) to raise the cost of abuse.
--
-- Bodies are lifted unchanged from their latest definitions:
--   vendor_insert_menu_items            — 20260710140001
--   vendor_update_menu_item             — 20260710140001
--   vendor_delete_menu_item             — 20260628000008
--   vendor_toggle_menu_item_availability — 20260628000008
-- All four RETURN void, so CREATE OR REPLACE is safe (no return-shape change).
-- Identity is asserted first via _assert_vendor_identity (same errors as the
-- previous inline checks), then the rate limit, then the original body.

-- ── 1. vendor_insert_menu_items ──────────────────────────────────────────────

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
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'vendor_insert_menu_items', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
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

-- ── 2. vendor_update_menu_item ───────────────────────────────────────────────

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
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'vendor_update_menu_item', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
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

-- ── 3. vendor_delete_menu_item ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_delete_menu_item(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'vendor_delete_menu_item', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  DELETE FROM public.vendor_menu_items mi
  USING public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── 4. vendor_toggle_menu_item_availability ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_toggle_menu_item_availability(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'vendor_toggle_menu_item_availability', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.vendor_menu_items mi
  SET is_available = NOT mi.is_available
  FROM public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── Grants (re-assert; unchanged signatures) ─────────────────────────────────

REVOKE ALL ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_delete_menu_item(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_delete_menu_item(uuid, text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_toggle_menu_item_availability(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_toggle_menu_item_availability(uuid, text, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) IS
  'Vendor menu batch insert. Phone-authorized (OTP-off), rate-limited 30/min per phone.';
COMMENT ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid) IS
  'Vendor menu item update. Phone-authorized (OTP-off), rate-limited 30/min per phone.';
COMMENT ON FUNCTION public.vendor_delete_menu_item(uuid, text, uuid) IS
  'Vendor menu item delete. Phone-authorized (OTP-off), rate-limited 30/min per phone.';
COMMENT ON FUNCTION public.vendor_toggle_menu_item_availability(uuid, text, uuid) IS
  'Vendor menu item availability toggle. Phone-authorized (OTP-off), rate-limited 30/min per phone.';
