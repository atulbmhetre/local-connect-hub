-- Phase 3: every new category stays pending until human review.
-- Extends pending metadata for AI mode reasoning / aliases / overlap.
-- Approving inserts seed aliases; merge-as-alias maps terms onto an existing category.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS ai_service_mode_reasoning text,
  ADD COLUMN IF NOT EXISTS proposed_aliases text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS overlap_category_label text,
  ADD COLUMN IF NOT EXISTS overlap_reasoning text;

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_status_check;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_status_check
  CHECK (status IN ('active', 'pending_review', 'rejected', 'merged'));

COMMENT ON COLUMN public.categories.ai_service_mode_reasoning IS
  'AI one-line reason for proposed service_mode (urgent vs scheduled / delivery).';
COMMENT ON COLUMN public.categories.proposed_aliases IS
  'AI-proposed search aliases (5–8); inserted into category_search_terms on approve.';
COMMENT ON COLUMN public.categories.overlap_category_label IS
  'If AI thinks this overlaps an existing active category, that category label.';
COMMENT ON COLUMN public.categories.overlap_reasoning IS
  'One-sentence AI explanation of the overlap (nullable when none).';

-- Approve: activate + seed proposed_aliases into category_search_terms (manual/active).
CREATE OR REPLACE FUNCTION public.admin_approve_category(
  p_admin_phone text,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_aliases text[];
  v_term text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT COALESCE(proposed_aliases, '{}'::text[])
  INTO v_aliases
  FROM public.categories
  WHERE id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category not found';
  END IF;

  UPDATE public.categories
  SET is_active = true,
      pending_review = false,
      status = 'active'
  WHERE id = p_category_id;

  IF v_aliases IS NOT NULL THEN
    FOREACH v_term IN ARRAY v_aliases
    LOOP
      v_term := lower(trim(v_term));
      IF v_term IS NULL OR v_term = '' THEN
        CONTINUE;
      END IF;
      INSERT INTO public.category_search_terms (
        category_id, term, language, source, status, confidence
      )
      VALUES (
        p_category_id, v_term, 'en', 'manual', 'active', NULL
      )
      ON CONFLICT (category_id, term) DO NOTHING;
    END LOOP;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_approve_category(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_category(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_category(text, uuid) TO authenticated;

-- Merge pending suggestion into an existing category as search aliases.
CREATE OR REPLACE FUNCTION public.admin_merge_category_as_alias(
  p_admin_phone text,
  p_pending_category_id uuid,
  p_target_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending public.categories%ROWTYPE;
  v_target_ok boolean;
  v_term text;
  v_terms text[] := '{}';
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT * INTO v_pending
  FROM public.categories
  WHERE id = p_pending_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending category not found';
  END IF;

  IF NOT (
    COALESCE(v_pending.status, '') = 'pending_review'
    OR (
      COALESCE(v_pending.pending_review, false) = true
      AND COALESCE(v_pending.is_active, false) = false
    )
  ) THEN
    RAISE EXCEPTION 'category is not pending review';
  END IF;

  IF p_pending_category_id = p_target_category_id THEN
    RAISE EXCEPTION 'cannot merge a category onto itself';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.categories c
    WHERE c.id = p_target_category_id
      AND COALESCE(c.is_active, false) = true
      AND COALESCE(c.status, 'active') IN ('active')
  ) INTO v_target_ok;

  IF NOT v_target_ok THEN
    RAISE EXCEPTION 'target category not found or not active';
  END IF;

  -- Suggested label + AI proposed aliases (and overlap label is NOT inserted as alias).
  v_terms := array_append(v_terms, lower(trim(v_pending.label)));
  IF v_pending.proposed_aliases IS NOT NULL THEN
    FOREACH v_term IN ARRAY v_pending.proposed_aliases
    LOOP
      v_term := lower(trim(v_term));
      IF v_term IS NULL OR v_term = '' THEN
        CONTINUE;
      END IF;
      IF NOT (v_term = ANY (v_terms)) THEN
        v_terms := array_append(v_terms, v_term);
      END IF;
    END LOOP;
  END IF;

  FOREACH v_term IN ARRAY v_terms
  LOOP
    IF v_term IS NULL OR v_term = '' THEN
      CONTINUE;
    END IF;
    INSERT INTO public.category_search_terms (
      category_id, term, language, source, status, confidence
    )
    VALUES (
      p_target_category_id, v_term, 'en', 'manual', 'active', NULL
    )
    ON CONFLICT (category_id, term) DO NOTHING;
  END LOOP;

  UPDATE public.categories
  SET is_active = false,
      pending_review = false,
      status = 'merged'
  WHERE id = p_pending_category_id;
END;
$$;

COMMENT ON FUNCTION public.admin_merge_category_as_alias(text, uuid, uuid) IS
  'Admin session only: map pending category label + proposed_aliases onto an active category as category_search_terms; mark pending status=merged.';

REVOKE ALL ON FUNCTION public.admin_merge_category_as_alias(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_merge_category_as_alias(text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_merge_category_as_alias(text, uuid, uuid) TO authenticated;
