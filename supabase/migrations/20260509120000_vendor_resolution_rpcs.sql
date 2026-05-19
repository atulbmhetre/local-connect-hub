-- Increment reputation counters from the Radar resolution buttons (SECURITY DEFINER bypasses RLS for the update).
-- Apply in Supabase SQL Editor or via `supabase db push`.

CREATE OR REPLACE FUNCTION public.increment_vendor_helped(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendors
  SET total_helped = COALESCE(total_helped, 0) + 1
  WHERE id = p_vendor_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_vendor_delivered(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendors
  SET total_delivered = COALESCE(total_delivered, 0) + 1
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_vendor_helped(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_vendor_helped(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.increment_vendor_delivered(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_vendor_delivered(uuid) TO anon, authenticated;
