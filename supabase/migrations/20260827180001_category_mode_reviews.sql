-- Phase: ongoing mode-confidence review from real vendor_category_modes counts.
-- Purely admin-facing; does not touch search/discovery/booking.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE TABLE IF NOT EXISTS public.category_mode_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  current_default_mode text NOT NULL
    CHECK (current_default_mode IN ('help', 'delivery', 'appointment')),
  proposed_mode text NOT NULL
    CHECK (proposed_mode IN ('help', 'delivery', 'appointment')),
  default_mode_vendor_count integer NOT NULL DEFAULT 0,
  proposed_mode_vendor_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'confirmed', 'dismissed')),
  -- When dismissed, re-flag only if proposed count rises by >= 2 above this floor.
  dismissed_at_proposed_count integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  CONSTRAINT category_mode_reviews_modes_differ CHECK (current_default_mode <> proposed_mode)
);

COMMENT ON TABLE public.category_mode_reviews IS
  'Admin signal when enough vendors offer a non-catalog-default mode for a category. Does not affect search.';

CREATE UNIQUE INDEX IF NOT EXISTS category_mode_reviews_one_pending_per_category
  ON public.category_mode_reviews (category_id)
  WHERE status = 'pending_review';

CREATE INDEX IF NOT EXISTS category_mode_reviews_pending_idx
  ON public.category_mode_reviews (created_at DESC)
  WHERE status = 'pending_review';

ALTER TABLE public.category_mode_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS category_mode_reviews_admin_read ON public.category_mode_reviews;
CREATE POLICY category_mode_reviews_admin_read
  ON public.category_mode_reviews
  FOR SELECT
  TO authenticated
  USING (public.is_admin_session());

-- Cheap per-category mode counts (approved businesses, distinct vendors).
CREATE OR REPLACE FUNCTION public._category_mode_vendor_counts(p_category_id uuid)
RETURNS TABLE (mode text, vendor_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    vcm.mode::text,
    COUNT(DISTINCT vc.vendor_id)::bigint AS vendor_count
  FROM public.vendor_categories vc
  INNER JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  INNER JOIN public.vendors v ON v.id = vc.vendor_id
  WHERE vc.category_id = p_category_id
    AND vc.status = 'approved'
    AND COALESCE(v.is_active, false) = true
    AND COALESCE(v.is_banned, false) = false
    AND v.deletion_requested_at IS NULL
  GROUP BY vcm.mode;
$$;

REVOKE ALL ON FUNCTION public._category_mode_vendor_counts(uuid) FROM PUBLIC;

/**
 * Fire-and-forget after registration / mode edit.
 * Inserts pending_review when a non-default mode has >= 3 vendors and no pending row.
 * Dismissed rows may re-flag if proposed count >= dismissed_at_proposed_count + 2.
 */
CREATE OR REPLACE FUNCTION public.maybe_flag_category_mode_reviews(
  p_category_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cat_id uuid;
  v_default text;
  v_help bigint;
  v_delivery bigint;
  v_appointment bigint;
  v_default_count bigint;
  v_proposed text;
  v_proposed_count bigint;
  v_has_pending boolean;
  v_dismiss_floor integer;
BEGIN
  IF p_category_ids IS NULL OR cardinality(p_category_ids) = 0 THEN
    RETURN;
  END IF;

  FOR v_cat_id IN
    SELECT DISTINCT x FROM unnest(p_category_ids) AS t(x) WHERE x IS NOT NULL
  LOOP
    SELECT lower(btrim(c.service_mode))
    INTO v_default
    FROM public.categories c
    WHERE c.id = v_cat_id
      AND c.is_active IS TRUE;

    IF v_default IS NULL OR v_default NOT IN ('help', 'delivery', 'appointment') THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.category_mode_reviews r
      WHERE r.category_id = v_cat_id
        AND r.status = 'pending_review'
    )
    INTO v_has_pending;

    IF v_has_pending THEN
      CONTINUE;
    END IF;

    SELECT
      COALESCE(MAX(CASE WHEN m.mode = 'help' THEN m.vendor_count END), 0),
      COALESCE(MAX(CASE WHEN m.mode = 'delivery' THEN m.vendor_count END), 0),
      COALESCE(MAX(CASE WHEN m.mode = 'appointment' THEN m.vendor_count END), 0)
    INTO v_help, v_delivery, v_appointment
    FROM public._category_mode_vendor_counts(v_cat_id) AS m;

    v_default_count := CASE v_default
      WHEN 'help' THEN v_help
      WHEN 'delivery' THEN v_delivery
      ELSE v_appointment
    END;

    -- Strongest non-default challenger
    v_proposed := NULL;
    v_proposed_count := 0;
    IF v_default <> 'help' AND v_help > v_proposed_count THEN
      v_proposed := 'help';
      v_proposed_count := v_help;
    END IF;
    IF v_default <> 'delivery' AND v_delivery > v_proposed_count THEN
      v_proposed := 'delivery';
      v_proposed_count := v_delivery;
    END IF;
    IF v_default <> 'appointment' AND v_appointment > v_proposed_count THEN
      v_proposed := 'appointment';
      v_proposed_count := v_appointment;
    END IF;

    IF v_proposed IS NULL OR v_proposed_count < 3 THEN
      CONTINUE;
    END IF;

    -- Dismissed floor: only re-flag after +2 growth on the same proposed mode
    SELECT r.dismissed_at_proposed_count
    INTO v_dismiss_floor
    FROM public.category_mode_reviews r
    WHERE r.category_id = v_cat_id
      AND r.status = 'dismissed'
      AND r.proposed_mode = v_proposed
    ORDER BY r.reviewed_at DESC NULLS LAST, r.created_at DESC
    LIMIT 1;

    IF v_dismiss_floor IS NOT NULL AND v_proposed_count < (v_dismiss_floor + 2) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.category_mode_reviews (
      category_id,
      current_default_mode,
      proposed_mode,
      default_mode_vendor_count,
      proposed_mode_vendor_count,
      status
    )
    VALUES (
      v_cat_id,
      v_default,
      v_proposed,
      v_default_count::integer,
      v_proposed_count::integer,
      'pending_review'
    )
    ON CONFLICT (category_id) WHERE (status = 'pending_review') DO NOTHING;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.maybe_flag_category_mode_reviews(uuid[]) IS
  'Cheap post-reg/edit check: flag category when >=3 vendors offer a non-default mode.';

GRANT EXECUTE ON FUNCTION public.maybe_flag_category_mode_reviews(uuid[])
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_confirm_category_mode_review(
  p_admin_phone text,
  p_review_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_id uuid;
  v_proposed text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT r.category_id, r.proposed_mode
  INTO v_category_id, v_proposed
  FROM public.category_mode_reviews r
  WHERE r.id = p_review_id
    AND r.status = 'pending_review'
  FOR UPDATE;

  IF v_category_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  UPDATE public.categories
  SET service_mode = v_proposed
  WHERE id = v_category_id;

  UPDATE public.category_mode_reviews
  SET status = 'confirmed', reviewed_at = now()
  WHERE id = p_review_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_dismiss_category_mode_review(
  p_admin_phone text,
  p_review_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposed_count integer;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT r.proposed_mode_vendor_count
  INTO v_proposed_count
  FROM public.category_mode_reviews r
  WHERE r.id = p_review_id
    AND r.status = 'pending_review'
  FOR UPDATE;

  IF v_proposed_count IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  UPDATE public.category_mode_reviews
  SET
    status = 'dismissed',
    reviewed_at = now(),
    dismissed_at_proposed_count = v_proposed_count
  WHERE id = p_review_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_category_mode_vendors(
  p_admin_phone text,
  p_category_id uuid,
  p_mode text
)
RETURNS TABLE (
  vendor_id uuid,
  shop_name text,
  phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF lower(btrim(COALESCE(p_mode, ''))) NOT IN ('help', 'delivery', 'appointment') THEN
    RAISE EXCEPTION 'invalid_mode';
  END IF;

  RETURN QUERY
  SELECT DISTINCT
    v.id AS vendor_id,
    COALESCE(NULLIF(btrim(vc.brand_name), ''), NULLIF(btrim(v.shop_name), ''), v.name) AS shop_name,
    v.phone
  FROM public.vendor_categories vc
  INNER JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  INNER JOIN public.vendors v ON v.id = vc.vendor_id
  WHERE vc.category_id = p_category_id
    AND vc.status = 'approved'
    AND vcm.mode = lower(btrim(p_mode))
    AND COALESCE(v.is_active, false) = true
    AND COALESCE(v.is_banned, false) = false
    AND v.deletion_requested_at IS NULL
  ORDER BY 2 ASC NULLS LAST
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_confirm_category_mode_review(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_dismiss_category_mode_review(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_list_category_mode_vendors(text, uuid, text) FROM anon;

GRANT EXECUTE ON FUNCTION public.admin_confirm_category_mode_review(text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_dismiss_category_mode_review(text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_category_mode_vendors(text, uuid, text)
  TO authenticated, service_role;
