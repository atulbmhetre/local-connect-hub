-- Phase 5: corrective AI aliases from exhausted Home searches.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
--
-- Investigation: ai-gateway strips candidates when confidence < threshold
-- (returns empty + no_confident_match). Unresolved rows are only written when
-- the user rejected a shown suggest sheet after rephrase — so a best-guess
-- category is always available on the client from those candidates.

-- Return type change void → uuid requires DROP first.
DROP FUNCTION IF EXISTS public.log_unresolved_search_term(text, text);

CREATE OR REPLACE FUNCTION public.log_unresolved_search_term(
  p_term text,
  p_original_term_if_rephrased text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := nullif(trim(coalesce(p_term, '')), '');
  v_original text := nullif(trim(coalesce(p_original_term_if_rephrased, '')), '');
  v_id uuid;
BEGIN
  IF v_term IS NULL THEN
    RETURN NULL;
  END IF;

  IF (
    SELECT count(*)::integer
    FROM public.unresolved_search_terms u
    WHERE u.created_at > now() - interval '1 minute'
      AND lower(u.term) = lower(v_term)
  ) >= 10 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.unresolved_search_terms (term, original_term_if_rephrased)
  VALUES (
    left(v_term, 200),
    CASE
      WHEN v_original IS NULL OR lower(v_original) = lower(v_term) THEN NULL
      ELSE left(v_original, 200)
    END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.log_unresolved_search_term(text, text) IS
  'Best-effort insert of an exhausted Home search term; returns row id for corrective alias follow-up.';

REVOKE ALL ON FUNCTION public.log_unresolved_search_term(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_unresolved_search_term(text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_unresolved_search_term_resolved(
  p_unresolved_id uuid,
  p_resolved_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_unresolved_id IS NULL OR p_resolved_category_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.unresolved_search_terms
  SET resolved_category_id = p_resolved_category_id
  WHERE id = p_unresolved_id
    AND resolved_category_id IS NULL;
END;
$$;

COMMENT ON FUNCTION public.mark_unresolved_search_term_resolved(uuid, uuid) IS
  'Mark an unresolved search row as having received a corrective alias proposal.';

REVOKE ALL ON FUNCTION public.mark_unresolved_search_term_resolved(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_unresolved_search_term_resolved(uuid, uuid)
  TO service_role;
