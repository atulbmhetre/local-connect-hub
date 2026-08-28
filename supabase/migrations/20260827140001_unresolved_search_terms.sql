-- Capture Home free-text searches that exhaust rephrase + fall through to the
-- category browse grid. Data only for a future corrective-alias-learning phase;
-- no auto-action or admin UI yet.

CREATE TABLE IF NOT EXISTS public.unresolved_search_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  original_term_if_rephrased text NULL,
  resolved_category_id uuid NULL REFERENCES public.categories(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unresolved_search_terms_created_at_idx
  ON public.unresolved_search_terms (created_at DESC);

CREATE INDEX IF NOT EXISTS unresolved_search_terms_term_lower_idx
  ON public.unresolved_search_terms (lower(term));

CREATE INDEX IF NOT EXISTS unresolved_search_terms_unresolved_idx
  ON public.unresolved_search_terms (created_at DESC)
  WHERE resolved_category_id IS NULL;

COMMENT ON TABLE public.unresolved_search_terms IS
  'Home search terms that exhausted rephrase then fell through to category browse. Capture-only for future alias learning.';

ALTER TABLE public.unresolved_search_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unresolved_search_terms_service ON public.unresolved_search_terms;
CREATE POLICY unresolved_search_terms_service ON public.unresolved_search_terms
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.log_unresolved_search_term(
  p_term text,
  p_original_term_if_rephrased text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := nullif(trim(coalesce(p_term, '')), '');
  v_original text := nullif(trim(coalesce(p_original_term_if_rephrased, '')), '');
BEGIN
  IF v_term IS NULL THEN
    RETURN;
  END IF;

  -- Soft rate limit: same term spam within a minute.
  IF (
    SELECT count(*)::integer
    FROM public.unresolved_search_terms u
    WHERE u.created_at > now() - interval '1 minute'
      AND lower(u.term) = lower(v_term)
  ) >= 10 THEN
    RETURN;
  END IF;

  INSERT INTO public.unresolved_search_terms (term, original_term_if_rephrased)
  VALUES (
    left(v_term, 200),
    CASE
      WHEN v_original IS NULL OR lower(v_original) = lower(v_term) THEN NULL
      ELSE left(v_original, 200)
    END
  );
END;
$$;

COMMENT ON FUNCTION public.log_unresolved_search_term(text, text) IS
  'Best-effort insert of an exhausted Home search term (capture-only).';

REVOKE ALL ON FUNCTION public.log_unresolved_search_term(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_unresolved_search_term(text, text)
  TO anon, authenticated, service_role;
