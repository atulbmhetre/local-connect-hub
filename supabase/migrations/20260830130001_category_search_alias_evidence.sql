-- Evidence threshold before AI aliases reach admin pending_review.
-- Matches Mode Confidence Review: 3 independent actors (distinct vendors for
-- proactive_ai; distinct customer device_ids for corrective_ai). Same actor
-- retrying does not increment. Alias volume is higher per event, but the unit
-- is (category, term, source), so 3 is the right analog — a one-off AI guess
-- never reaches the queue.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE TABLE IF NOT EXISTS public.category_search_term_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  term text NOT NULL,
  source text NOT NULL CHECK (source IN ('proactive_ai', 'corrective_ai')),
  actor_key text NOT NULL,
  confidence numeric(4, 2) NULL,
  ai_reasoning text NULL,
  suggested_by_vendor_id uuid NULL REFERENCES public.vendors(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_search_term_evidence_actor_unique
    UNIQUE (category_id, term, source, actor_key)
);

CREATE INDEX IF NOT EXISTS category_search_term_evidence_lookup_idx
  ON public.category_search_term_evidence (category_id, lower(term), source);

COMMENT ON TABLE public.category_search_term_evidence IS
  'Independent alias proposals. A pending_review category_search_terms row is created only after 3 distinct actors.';

ALTER TABLE public.category_search_term_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS category_search_term_evidence_service ON public.category_search_term_evidence;
CREATE POLICY category_search_term_evidence_service
  ON public.category_search_term_evidence
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS category_search_term_evidence_admin_read ON public.category_search_term_evidence;
CREATE POLICY category_search_term_evidence_admin_read
  ON public.category_search_term_evidence
  FOR SELECT
  TO authenticated
  USING (public.is_admin_session());

CREATE OR REPLACE FUNCTION public.record_search_alias_evidence(
  p_category_id uuid,
  p_term text,
  p_source text,
  p_actor_key text,
  p_confidence numeric DEFAULT NULL,
  p_ai_reasoning text DEFAULT NULL,
  p_suggested_by_vendor_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text;
  v_source text;
  v_actor text;
  v_count integer;
  v_threshold integer := 3;
  v_existing_status text;
  v_confidence numeric(4, 2);
  v_reasoning text;
  v_vendor uuid;
BEGIN
  v_term := lower(btrim(regexp_replace(coalesce(p_term, ''), '\s+', ' ', 'g')));
  v_source := lower(btrim(coalesce(p_source, '')));
  v_actor := btrim(coalesce(p_actor_key, ''));

  IF p_category_id IS NULL OR v_term IS NULL OR length(v_term) < 2 OR length(v_term) > 80 THEN
    RETURN 'skipped_invalid';
  END IF;
  IF v_source NOT IN ('proactive_ai', 'corrective_ai') THEN
    RETURN 'skipped_invalid';
  END IF;
  IF v_actor = '' OR length(v_actor) > 128 THEN
    RETURN 'skipped_invalid';
  END IF;

  SELECT cst.status
  INTO v_existing_status
  FROM public.category_search_terms cst
  WHERE cst.category_id = p_category_id
    AND lower(cst.term) = v_term
  LIMIT 1;

  IF v_existing_status = 'active' THEN
    RETURN 'skipped_exists_active';
  END IF;
  IF v_existing_status = 'pending_review' THEN
    RETURN 'skipped_exists_pending';
  END IF;

  INSERT INTO public.category_search_term_evidence (
    category_id,
    term,
    source,
    actor_key,
    confidence,
    ai_reasoning,
    suggested_by_vendor_id
  )
  VALUES (
    p_category_id,
    v_term,
    v_source,
    left(v_actor, 128),
    CASE
      WHEN p_confidence IS NOT NULL AND p_confidence >= 0 AND p_confidence <= 1
        THEN round(p_confidence, 2)
      ELSE NULL
    END,
    NULLIF(left(btrim(coalesce(p_ai_reasoning, '')), 500), ''),
    p_suggested_by_vendor_id
  )
  ON CONFLICT (category_id, term, source, actor_key) DO UPDATE
    SET
      confidence = COALESCE(EXCLUDED.confidence, public.category_search_term_evidence.confidence),
      ai_reasoning = COALESCE(EXCLUDED.ai_reasoning, public.category_search_term_evidence.ai_reasoning),
      suggested_by_vendor_id = COALESCE(
        EXCLUDED.suggested_by_vendor_id,
        public.category_search_term_evidence.suggested_by_vendor_id
      );

  SELECT count(*)::integer
  INTO v_count
  FROM public.category_search_term_evidence e
  WHERE e.category_id = p_category_id
    AND e.term = v_term
    AND e.source = v_source;

  IF v_count < v_threshold THEN
    RETURN 'recorded';
  END IF;

  SELECT e.confidence, e.ai_reasoning, e.suggested_by_vendor_id
  INTO v_confidence, v_reasoning, v_vendor
  FROM public.category_search_term_evidence e
  WHERE e.category_id = p_category_id
    AND e.term = v_term
    AND e.source = v_source
  ORDER BY e.confidence DESC NULLS LAST, e.created_at DESC
  LIMIT 1;

  INSERT INTO public.category_search_terms (
    category_id,
    term,
    language,
    source,
    status,
    confidence,
    ai_reasoning,
    suggested_by_vendor_id
  )
  VALUES (
    p_category_id,
    v_term,
    'en',
    v_source,
    'pending_review',
    v_confidence,
    v_reasoning,
    v_vendor
  )
  ON CONFLICT (category_id, term) DO NOTHING;

  RETURN 'queued';
END;
$$;

COMMENT ON FUNCTION public.record_search_alias_evidence(uuid, text, text, text, numeric, text, uuid) IS
  'Record one independent alias signal. Inserts pending_review only after 3 distinct actors for the same (category, term, source).';

REVOKE ALL ON FUNCTION public.record_search_alias_evidence(uuid, text, text, text, numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_search_alias_evidence(uuid, text, text, text, numeric, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_search_alias_evidence(uuid, text, text, text, numeric, text, uuid)
  TO service_role;

GRANT ALL ON TABLE public.category_search_term_evidence TO postgres, service_role;
GRANT SELECT ON TABLE public.category_search_term_evidence TO authenticated;
