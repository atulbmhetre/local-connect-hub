-- AI license classification on categories (reuse suggest-category).
-- Proposed license_type is stored unapproved; wizard uses it only after admin sign-off.
-- Shop & Establishment is collected in the client for every business and is not AI-classified.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS license_type text,
  ADD COLUMN IF NOT EXISTS license_confidence_score numeric(4, 2),
  ADD COLUMN IF NOT EXISTS license_reasoning text,
  ADD COLUMN IF NOT EXISTS license_review_status text;

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_license_review_status_check;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_license_review_status_check
  CHECK (
    license_review_status IS NULL
    OR license_review_status IN ('pending_review', 'approved', 'rejected')
  );

COMMENT ON COLUMN public.categories.license_type IS
  'AI-proposed sector-specific Indian government license/registration name, or generic. Unused until license_review_status=approved.';
COMMENT ON COLUMN public.categories.license_confidence_score IS
  'Same 0-1 confidence returned by suggest-category (not a separate license score).';
COMMENT ON COLUMN public.categories.license_reasoning IS
  'One-line AI reason for license_type (includes downgrade note when gated to generic).';
COMMENT ON COLUMN public.categories.license_review_status IS
  'pending_review until admin approves/rejects. Null = never classified. Never auto-approved.';

CREATE INDEX IF NOT EXISTS categories_license_pending_review_idx
  ON public.categories (created_at DESC)
  WHERE license_review_status = 'pending_review';

CREATE OR REPLACE FUNCTION public.admin_list_pending_category_licenses()
RETURNS TABLE (
  id uuid,
  label text,
  emoji text,
  license_type text,
  license_confidence_score numeric,
  license_reasoning text,
  is_active boolean,
  status text
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
    c.id,
    c.label,
    c.emoji,
    c.license_type,
    c.license_confidence_score,
    c.license_reasoning,
    c.is_active,
    c.status
  FROM public.categories c
  WHERE c.license_review_status = 'pending_review'
    AND (
      c.is_active = true
      OR c.status = 'pending_review'
      OR COALESCE(c.pending_review, false) = true
    )
  ORDER BY c.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.admin_list_pending_category_licenses() IS
  'Admin session only: categories whose AI license classification awaits human review.';

REVOKE ALL ON FUNCTION public.admin_list_pending_category_licenses() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_pending_category_licenses() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_category_licenses() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_approve_category_license(
  p_admin_phone text,
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

  UPDATE public.categories
  SET license_review_status = 'approved'
  WHERE id = p_category_id
    AND license_review_status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'license classification not pending';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_approve_category_license(text, uuid) IS
  'Admin session only: mark AI license_type as approved for wizard use. Does not activate the category.';

REVOKE ALL ON FUNCTION public.admin_approve_category_license(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_category_license(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_category_license(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reject_category_license(
  p_admin_phone text,
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

  UPDATE public.categories
  SET license_review_status = 'rejected'
  WHERE id = p_category_id
    AND license_review_status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'license classification not pending';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_reject_category_license(text, uuid) IS
  'Admin session only: reject AI license_type. Wizard ignores it (Shop & Establishment still always shown).';

REVOKE ALL ON FUNCTION public.admin_reject_category_license(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reject_category_license(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_category_license(text, uuid) TO authenticated;
