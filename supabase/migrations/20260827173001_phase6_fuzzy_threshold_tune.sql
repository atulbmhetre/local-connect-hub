-- Phase 6 tune: hybrid similarity gate so "mecanik" (≈0.33 vs mikanik/mechanic)
-- clears while common near-misses like "message"→"massage" do not.

CREATE OR REPLACE FUNCTION public.fuzzy_match_category_search_terms(
  p_input text,
  p_threshold double precision DEFAULT 0.3
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
  -- Expand each single-token alias / label against full query + long tokens.
  raw AS (
    SELECT
      cst.category_id,
      c.label,
      lower(btrim(cst.term)) AS cand,
      cst.term AS matched_term,
      tok.token AS against,
      extensions.similarity(lower(btrim(cst.term)), tok.token) AS score
    FROM public.category_search_terms cst
    INNER JOIN public.categories c ON c.id = cst.category_id
    CROSS JOIN tokens tok
    WHERE cst.status = 'active'
      AND c.is_active IS TRUE
      AND position(' ' IN btrim(cst.term)) = 0
      AND (SELECT length(q) FROM input) >= 4
      AND abs(length(lower(btrim(cst.term))) - length(tok.token)) <= 2

    UNION ALL

    SELECT
      cst.category_id,
      c.label,
      lower(btrim(cst.term)) AS cand,
      cst.term AS matched_term,
      (SELECT q FROM input) AS against,
      extensions.similarity(lower(btrim(cst.term)), (SELECT q FROM input)) AS score
    FROM public.category_search_terms cst
    INNER JOIN public.categories c ON c.id = cst.category_id
    WHERE cst.status = 'active'
      AND c.is_active IS TRUE
      AND position(' ' IN btrim(cst.term)) = 0
      AND (SELECT length(q) FROM input) >= 5
      AND abs(length(lower(btrim(cst.term))) - (SELECT length(q) FROM input)) <= 2

    UNION ALL

    SELECT
      c.id AS category_id,
      c.label,
      lower(btrim(c.label)) AS cand,
      c.label AS matched_term,
      tok.token AS against,
      extensions.similarity(lower(btrim(c.label)), tok.token) AS score
    FROM public.categories c
    CROSS JOIN tokens tok
    WHERE c.is_active IS TRUE
      AND position(' ' IN btrim(c.label)) = 0
      AND (SELECT length(q) FROM input) >= 4
      AND abs(length(lower(btrim(c.label))) - length(tok.token)) <= 2

    UNION ALL

    SELECT
      c.id AS category_id,
      c.label,
      lower(btrim(c.label)) AS cand,
      c.label AS matched_term,
      (SELECT q FROM input) AS against,
      extensions.similarity(lower(btrim(c.label)), (SELECT q FROM input)) AS score
    FROM public.categories c
    WHERE c.is_active IS TRUE
      AND position(' ' IN btrim(c.label)) = 0
      AND (SELECT length(q) FROM input) >= 5
      AND abs(length(lower(btrim(c.label))) - (SELECT length(q) FROM input)) <= 2
  ),
  gated AS (
    SELECT *
    FROM raw
    WHERE
      -- Strong trigram hit
      score >= GREATEST(COALESCE(p_threshold, 0.3) + 0.1, 0.4)
      OR (
        -- Weaker band: typo-shaped (shared prefix + similar length)
        score >= COALESCE(p_threshold, 0.3)
        AND left(cand, 2) = left(against, 2)
        AND abs(length(cand) - length(against)) <= 2
      )
  ),
  best AS (
    SELECT DISTINCT ON (gated.category_id)
      gated.category_id,
      gated.label,
      gated.matched_term,
      gated.score
    FROM gated
    ORDER BY gated.category_id, gated.score DESC
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
  'Phase 6: trigram fuzzy matches for typo tolerance (hybrid 0.3+prefix / 0.4 strong). Client: Did-you-mean only.';
