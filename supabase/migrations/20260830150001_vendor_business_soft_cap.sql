-- Soft-cap vendor businesses at 5: 6th+ still save, but pending_review until
-- admin approval. Client MAX_VENDOR_CATEGORIES=5 was a hard disable; there is
-- no server cap today. Own admin queue (not Pending Categories — that reviews
-- catalog categories, not a vendor's extra business).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS review_reason text NULL;

COMMENT ON COLUMN public.vendor_categories.review_reason IS
  'Admin reject reason for a pending_review extra business. Shown to the vendor.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vendor_categories_status_check'
      AND conrelid = 'public.vendor_categories'::regclass
  ) THEN
    ALTER TABLE public.vendor_categories
      ADD CONSTRAINT vendor_categories_status_check
      CHECK (status IN ('approved', 'pending_review', 'rejected', 'pending'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vendor_categories_pending_review_idx
  ON public.vendor_categories (created_at DESC)
  WHERE status = 'pending_review';

-- ── Soft-cap INSERT: rewrite approved → pending_review when 5 live already ──

CREATE OR REPLACE FUNCTION public._vendor_category_soft_cap_bi()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_approved integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO v_approved
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = NEW.vendor_id
    AND vc.status = 'approved';

  IF v_approved >= 5 THEN
    NEW.status := 'pending_review';
    NEW.needs_review := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_categories_soft_cap_bi ON public.vendor_categories;
CREATE TRIGGER vendor_categories_soft_cap_bi
  BEFORE INSERT ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public._vendor_category_soft_cap_bi();

-- ── Availability modes: only approved businesses ────────────────────────────

CREATE OR REPLACE FUNCTION public._derive_vendor_availability_modes(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_modes text[];
  v_mode text;
  v_primary text;
BEGIN
  SELECT public._normalize_availability_modes(COALESCE(array_agg(vcm.mode), ARRAY[]::text[]))
  INTO v_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id
    AND vc.status = 'approved';

  IF COALESCE(array_length(v_modes, 1), 0) = 0 THEN
    SELECT public._normalize_availability_modes(ARRAY[COALESCE(v.service_mode, 'help')])
    INTO v_modes
    FROM public.vendors v
    WHERE v.id = p_vendor_id;
  END IF;

  DELETE FROM public.vendor_availability_modes WHERE vendor_id = p_vendor_id;

  FOREACH v_mode IN ARRAY v_modes LOOP
    INSERT INTO public.vendor_availability_modes (vendor_id, mode)
    VALUES (p_vendor_id, v_mode)
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT vc.service_mode
  INTO v_primary
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.status = 'approved'
  ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
  LIMIT 1;

  IF v_primary IS NULL THEN
    v_primary := public._pick_primary_availability_mode(v_modes, NULL);
  END IF;

  UPDATE public.vendors
  SET service_mode = v_primary
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public._derive_vendor_availability_modes(uuid) FROM PUBLIC;

-- ── Booking: hinted non-approved business must not fall through ─────────────

CREATE OR REPLACE FUNCTION public._reject_unapproved_booking_hint(
  p_vendor_id uuid,
  p_hint_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_hint_category_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status IS DISTINCT FROM 'approved'
  ) THEN
    RAISE EXCEPTION 'vendor_not_discoverable';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._reject_unapproved_booking_hint(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._reject_unapproved_booking_hint(uuid, uuid)
  TO anon, authenticated, service_role;

-- Patch _resolve_booking_category: reject hinted non-approved businesses
-- (pending_review 6th+) instead of falling through to another approved row.

DO $inject$
DECLARE
  def text;
  injected text;
  perform_stmt text;
  r record;
BEGIN
  perform_stmt :=
    '  PERFORM public._reject_unapproved_booking_hint(p_vendor_id, p_hint_category_id);';

  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = '_resolve_booking_category'
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('public._reject_unapproved_booking_hint' IN def) > 0 THEN
      RAISE NOTICE '_resolve_booking_category already has unapproved-hint gate';
      CONTINUE;
    END IF;

    injected := regexp_replace(
      def,
      E'(AS \\$function\\$[\\s\\S]*?BEGIN\\r?\\n)',
      E'\\1' || perform_stmt || E'\n\n'
    );

    IF injected IS NULL OR injected = def THEN
      RAISE EXCEPTION 'soft-cap hint inject failed for _resolve_booking_category';
    END IF;

    EXECUTE injected;
  END LOOP;
END;
$inject$;

-- ── Admin read + review RPCs ────────────────────────────────────────────────

DROP POLICY IF EXISTS vendor_categories_admin_read ON public.vendor_categories;
CREATE POLICY vendor_categories_admin_read ON public.vendor_categories
  FOR SELECT
  TO authenticated
  USING (public.is_admin_session());

CREATE OR REPLACE FUNCTION public.admin_list_pending_vendor_businesses()
RETURNS TABLE (
  vendor_category_id uuid,
  vendor_id uuid,
  shop_name text,
  vendor_phone text,
  vendor_name text,
  category_id uuid,
  category_label text,
  category_emoji text,
  brand_name text,
  created_at timestamptz,
  approved_businesses jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    vc.id,
    v.id,
    v.shop_name,
    v.phone,
    v.name,
    vc.category_id,
    c.label,
    c.emoji,
    vc.brand_name,
    vc.created_at,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'category_id', avc.category_id,
          'label', ac.label,
          'emoji', ac.emoji,
          'brand_name', avc.brand_name
        )
        ORDER BY avc.is_primary DESC NULLS LAST, avc.created_at ASC
      )
      FROM public.vendor_categories avc
      JOIN public.categories ac ON ac.id = avc.category_id
      WHERE avc.vendor_id = v.id
        AND avc.status = 'approved'
    ), '[]'::jsonb)
  FROM public.vendor_categories vc
  JOIN public.vendors v ON v.id = vc.vendor_id
  JOIN public.categories c ON c.id = vc.category_id
  WHERE vc.status = 'pending_review'
  ORDER BY vc.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_pending_vendor_businesses() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_pending_vendor_businesses() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_vendor_businesses() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_approve_vendor_business(
  p_admin_phone text,
  p_vendor_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  UPDATE public.vendor_categories
  SET
    status = 'approved',
    needs_review = false,
    review_reason = NULL
  WHERE id = p_vendor_category_id
    AND status = 'pending_review'
  RETURNING vendor_id INTO v_vendor_id;

  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'vendor_business_not_pending';
  END IF;

  PERFORM public._derive_vendor_availability_modes(v_vendor_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_vendor_business(
  p_admin_phone text,
  p_vendor_category_id uuid,
  p_reason text DEFAULT NULL
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
    status = 'rejected',
    needs_review = false,
    review_reason = NULLIF(left(btrim(COALESCE(p_reason, '')), 280), '')
  WHERE id = p_vendor_category_id
    AND status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_business_not_pending';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_approve_vendor_business(text, uuid) IS
  'Admin session: activate a 6th+ business that was held at the soft cap.';
COMMENT ON FUNCTION public.admin_reject_vendor_business(text, uuid, text) IS
  'Admin session: reject a 6th+ business. Optional reason is shown to the vendor.';

REVOKE ALL ON FUNCTION public.admin_approve_vendor_business(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_vendor_business(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_vendor_business(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reject_vendor_business(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reject_vendor_business(text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_vendor_business(text, uuid, text) TO authenticated;
