-- R1: increment_vendor_issues RPC for "Had an issue" rating feedback.

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS total_issues integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.increment_vendor_issues(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendors
  SET total_issues = COALESCE(total_issues, 0) + 1
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_vendor_issues(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_vendor_issues(uuid) TO anon, authenticated;
