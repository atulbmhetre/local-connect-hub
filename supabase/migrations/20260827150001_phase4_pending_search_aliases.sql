-- Phase 4: proactive AI search aliases from vendor profile (pending human review).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.category_search_terms
  ADD COLUMN IF NOT EXISTS suggested_by_vendor_id uuid
    REFERENCES public.vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_reasoning text;

COMMENT ON COLUMN public.category_search_terms.suggested_by_vendor_id IS
  'Vendor whose profile triggered a proactive_ai alias proposal (nullable for manual/seed rows).';
COMMENT ON COLUMN public.category_search_terms.ai_reasoning IS
  'One-line AI reasoning for proactive_ai / corrective_ai proposals.';

CREATE INDEX IF NOT EXISTS category_search_terms_pending_review_idx
  ON public.category_search_terms (created_at DESC)
  WHERE status = 'pending_review';

-- Admin can read pending rows in Settings (anon/public still see active only).
DROP POLICY IF EXISTS category_search_terms_admin_read ON public.category_search_terms;
CREATE POLICY category_search_terms_admin_read
  ON public.category_search_terms
  FOR SELECT
  TO authenticated
  USING (public.is_admin_session());

CREATE OR REPLACE FUNCTION public.admin_approve_search_term(
  p_admin_phone text,
  p_term_id uuid
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

  UPDATE public.category_search_terms
  SET status = 'active'
  WHERE id = p_term_id
    AND status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'search term not found or not pending';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_approve_search_term(text, uuid) IS
  'Admin session only: activate a pending_review category_search_terms row.';

CREATE OR REPLACE FUNCTION public.admin_reject_search_term(
  p_admin_phone text,
  p_term_id uuid
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

  DELETE FROM public.category_search_terms
  WHERE id = p_term_id
    AND status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'search term not found or not pending';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_reject_search_term(text, uuid) IS
  'Admin session only: delete a pending_review category_search_terms row.';

REVOKE ALL ON FUNCTION public.admin_approve_search_term(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_approve_search_term(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_search_term(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reject_search_term(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reject_search_term(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_search_term(text, uuid) TO authenticated;
