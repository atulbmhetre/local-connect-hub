-- Phase 6: typo tolerance on category_search_terms via pg_trgm.
-- Fuzzy matches are for "Did you mean" confirmation only (client never treats
-- them as silent exact navigation). Apply to TEST first.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Trigram index for similarity / % queries on alias terms.
CREATE INDEX IF NOT EXISTS category_search_terms_term_trgm_idx
  ON public.category_search_terms
  USING gin (lower(term) extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS categories_label_trgm_idx
  ON public.categories
  USING gin (lower(label) extensions.gin_trgm_ops);

/**
 * Fuzzy-match active aliases / labels for a free-text search input.
 *
 * Guards against short-word false positives:
 *  - input must be at least 4 chars
 *  - each scored token must be at least 5 chars
 *  - length delta between token and candidate term/label <= 3
 *  - default similarity threshold 0.4
 *
 * Returns one row per category (best score), ranked by score desc.
 */
CREATE OR REPLACE FUNCTION public.fuzzy_match_category_search_terms(
  p_input text,
  p_threshold double precision DEFAULT 0.4
)
RETURNS TABLE (
  category_id uuid,
  label text,
  matched_term text,
  score double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH input AS (
    SELECT lower(btrim(COALESCE(p_input, ''))) AS q
  ),
  tokens AS (
    SELECT DISTINCT t.token
    FROM input i,
    LATERAL unnest(regexp_split_to_array(i.q, '[[:space:]]+')) AS t(token)
    WHERE length(t.token) >= 5
  ),
  candidates AS (
    -- Single-token alias rows
    SELECT
      cst.category_id,
      c.label,
      cst.term AS matched_term,
      GREATEST(
        COALESCE(
          (
            SELECT max(extensions.similarity(lower(cst.term), tok.token))
            FROM tokens tok
            WHERE abs(length(lower(cst.term)) - length(tok.token)) <= 3
          ),
          0
        ),
        CASE
          WHEN (SELECT length(q) FROM input) >= 5
            AND abs(length(lower(cst.term)) - (SELECT length(q) FROM input)) <= 3
          THEN extensions.similarity(lower(cst.term), (SELECT q FROM input))
          ELSE 0
        END
      ) AS score
    FROM public.category_search_terms cst
    INNER JOIN public.categories c ON c.id = cst.category_id
    WHERE cst.status = 'active'
      AND c.is_active IS TRUE
      AND position(' ' IN btrim(cst.term)) = 0
      AND (SELECT length(q) FROM input) >= 4

    UNION ALL

    -- Category labels (single-word portion of label when no spaces, else full label vs full q)
    SELECT
      c.id AS category_id,
      c.label,
      c.label AS matched_term,
      GREATEST(
        COALESCE(
          (
            SELECT max(extensions.similarity(lower(c.label), tok.token))
            FROM tokens tok
            WHERE abs(length(lower(c.label)) - length(tok.token)) <= 3
          ),
          0
        ),
        CASE
          WHEN (SELECT length(q) FROM input) >= 5
            AND abs(length(lower(c.label)) - (SELECT length(q) FROM input)) <= 3
          THEN extensions.similarity(lower(c.label), (SELECT q FROM input))
          ELSE 0
        END
      ) AS score
    FROM public.categories c
    WHERE c.is_active IS TRUE
      AND position(' ' IN btrim(c.label)) = 0
      AND (SELECT length(q) FROM input) >= 4
  ),
  best AS (
    SELECT DISTINCT ON (candidates.category_id)
      candidates.category_id,
      candidates.label,
      candidates.matched_term,
      candidates.score
    FROM candidates
    WHERE candidates.score >= COALESCE(p_threshold, 0.4)
    ORDER BY candidates.category_id, candidates.score DESC
  )
  SELECT
    best.category_id,
    best.label,
    best.matched_term,
    best.score
  FROM best
  ORDER BY best.score DESC, best.label ASC
  LIMIT 8;
$$;

COMMENT ON FUNCTION public.fuzzy_match_category_search_terms(text, double precision) IS
  'Phase 6: trigram fuzzy matches for typo tolerance. Client must show as Did-you-mean candidates only — never silent exact navigation.';

GRANT EXECUTE ON FUNCTION public.fuzzy_match_category_search_terms(text, double precision)
  TO anon, authenticated, service_role;
