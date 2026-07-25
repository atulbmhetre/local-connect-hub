-- 1) Optional menu-item photos (nullable image_url + menu-photos bucket).
-- 2) Feed notify: offers always deliver; announcement/recommendation respect
--    user_devices.feed_notifications_enabled (no new column).

-- ── vendor_menu_items.image_url ──────────────────────────────────────────────

ALTER TABLE public.vendor_menu_items
  ADD COLUMN IF NOT EXISTS image_url text;

COMMENT ON COLUMN public.vendor_menu_items.image_url IS
  'Optional public URL of a menu-item photo in the menu-photos storage bucket.';

-- ── menu-photos bucket (same limits as shop-photos) ────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'menu-photos',
  'menu-photos',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Anon upload menu photos" ON storage.objects;
DROP POLICY IF EXISTS "Anon update menu photos" ON storage.objects;
DROP POLICY IF EXISTS "Anon delete menu photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read menu photos" ON storage.objects;

CREATE POLICY "Anon upload menu photos"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'menu-photos');

CREATE POLICY "Anon update menu photos"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'menu-photos')
WITH CHECK (bucket_id = 'menu-photos');

CREATE POLICY "Anon delete menu photos"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'menu-photos');

CREATE POLICY "Public read menu photos"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'menu-photos');

-- ── Menu RPCs: accept optional image_url ───────────────────────────────────

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
  v_image text;
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

    v_image := NULLIF(btrim(COALESCE(v_item->>'image_url', '')), '');
    IF v_image IS NOT NULL THEN
      IF char_length(v_image) > 2000 OR v_image !~* '^https://' THEN
        RAISE EXCEPTION 'invalid_menu_image_url';
      END IF;
    END IF;

    INSERT INTO public.vendor_menu_items (
      vendor_id,
      name,
      price,
      unit,
      description,
      sort_order,
      is_available,
      category_id,
      image_url
    )
    VALUES (
      p_vendor_id,
      COALESCE(v_item->>'name', ''),
      COALESCE((v_item->>'price')::numeric, 0),
      NULLIF(v_item->>'unit', ''),
      NULLIF(v_item->>'description', ''),
      COALESCE((v_item->>'sort_order')::integer, 0),
      COALESCE((v_item->>'is_available')::boolean, true),
      v_cat,
      v_image
    );
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid);

CREATE OR REPLACE FUNCTION public.vendor_update_menu_item(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid,
  p_name text,
  p_price numeric,
  p_unit text,
  p_description text,
  p_category_id uuid DEFAULT NULL,
  p_image_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sole uuid;
  v_cat uuid;
  v_image text;
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

  -- NULL p_image_url = leave unchanged; '' = clear; https URL = set.
  IF p_image_url IS NULL THEN
    v_image := NULL; -- sentinel handled below
  ELSE
    v_image := NULLIF(btrim(p_image_url), '');
    IF v_image IS NOT NULL AND (char_length(v_image) > 2000 OR v_image !~* '^https://') THEN
      RAISE EXCEPTION 'invalid_menu_image_url';
    END IF;
  END IF;

  UPDATE public.vendor_menu_items mi
  SET
    name = p_name,
    price = p_price,
    unit = NULLIF(p_unit, ''),
    description = NULLIF(p_description, ''),
    category_id = COALESCE(v_cat, mi.category_id),
    image_url = CASE
      WHEN p_image_url IS NULL THEN mi.image_url
      ELSE v_image
    END
  FROM public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb)
  TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) IS
  'Vendor menu batch insert. Optional image_url per item. Phone-authorized, rate-limited 30/min.';
COMMENT ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text, uuid, text) IS
  'Vendor menu item update. p_image_url NULL=unchanged, empty=clear, https=set. Phone-authorized, rate-limited 30/min.';

-- ── Feed notify: offers ignore feed_notifications_enabled ──────────────────

CREATE OR REPLACE FUNCTION public.get_feed_post_notify_devices(
  p_post_id uuid,
  p_radius_km numeric DEFAULT NULL,
  p_author_phone text DEFAULT NULL
)
RETURNS TABLE (
  user_phone text,
  fcm_token text,
  last_lat double precision,
  last_lng double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audience text;
  v_category_id uuid;
  v_lat double precision;
  v_lng double precision;
  v_post_type text;
  v_post_reach numeric;
  v_recommended_vendor_id uuid;
  v_vendor_service_radius numeric;
  v_effective_reach numeric;
  v_author text;
BEGIN
  IF p_post_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(NULLIF(trim(fp.target_audience), ''), 'customers'),
    fp.target_category_id,
    fp.lat,
    fp.lng,
    NULLIF(trim(fp.user_phone), ''),
    fp.type,
    fp.reach_radius_km,
    fp.recommended_vendor_id
  INTO v_audience, v_category_id, v_lat, v_lng, v_author, v_post_type, v_post_reach, v_recommended_vendor_id
  FROM public.feed_posts fp
  WHERE fp.id = p_post_id;

  IF NOT FOUND OR v_lat IS NULL OR v_lng IS NULL THEN
    RETURN;
  END IF;

  IF p_author_phone IS NOT NULL AND NULLIF(trim(p_author_phone), '') IS NOT NULL THEN
    v_author := NULLIF(trim(p_author_phone), '');
  END IF;

  v_effective_reach := COALESCE(NULLIF(v_post_reach, 0), 5);
  IF v_post_type = 'recommendation' AND v_recommended_vendor_id IS NOT NULL THEN
    SELECT NULLIF(v.service_radius_km, 0)
    INTO v_vendor_service_radius
    FROM public.vendors v
    WHERE v.id = v_recommended_vendor_id;

    IF v_vendor_service_radius IS NOT NULL THEN
      v_effective_reach := LEAST(v_effective_reach, v_vendor_service_radius);
    END IF;
  END IF;

  IF p_radius_km IS NOT NULL AND p_radius_km > 0 THEN
    v_effective_reach := LEAST(v_effective_reach, p_radius_km);
  END IF;

  RETURN QUERY
  SELECT
    ud.user_phone,
    ud.fcm_token,
    ud.last_lat,
    ud.last_lng
  FROM public.user_devices ud
  LEFT JOIN LATERAL (
    SELECT v.id AS vendor_id
    FROM public.vendors v
    WHERE v.phone = ud.user_phone
    ORDER BY v.created_at DESC NULLS LAST
    LIMIT 1
  ) reader ON true
  LEFT JOIN public.app_users au ON au.phone = ud.user_phone
  WHERE ud.is_current IS TRUE
    -- Offers always notify; announcements/recommendations honor the toggle.
    AND (
      v_post_type = 'offer'
      OR ud.feed_notifications_enabled IS TRUE
    )
    AND ud.last_location_at > now() - interval '30 days'
    AND ud.fcm_token IS NOT NULL
    AND NULLIF(trim(ud.fcm_token), '') IS NOT NULL
    AND ud.last_lat IS NOT NULL
    AND ud.last_lng IS NOT NULL
    AND (v_author IS NULL OR ud.user_phone IS DISTINCT FROM v_author)
    AND (
      6371 * 2 * asin(sqrt(
        power(sin(radians(ud.last_lat - v_lat) / 2), 2)
        + cos(radians(v_lat)) * cos(radians(ud.last_lat))
          * power(sin(radians(ud.last_lng - v_lng) / 2), 2)
      ))
    ) <= LEAST(
      v_effective_reach,
      COALESCE(
        CASE WHEN au.phone IS NULL THEN 5 ELSE au.feed_discovery_radius_km END,
        v_effective_reach
      )
    )
    AND public.feed_post_matches_reader_audience(
      v_audience,
      v_category_id,
      reader.vendor_id
    );
END;
$$;

COMMENT ON FUNCTION public.get_feed_post_notify_devices(uuid, numeric, text) IS
  'Feed push audience: offers always included; announcement/recommendation require feed_notifications_enabled.';
