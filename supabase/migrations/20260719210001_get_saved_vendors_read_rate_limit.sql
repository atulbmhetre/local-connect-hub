-- Raise the get_saved_vendors read limit to 120/60s under its own action key.
--
-- 30/60s (mirrored from the save/unsave/migrate mutation RPCs) is too tight for
-- this read path: Radar calls it once per search load (RadarSearch.tsx) and
-- again per vendor card on saved-state refresh (RadarVendorCard.tsx), so a
-- dense results list can legitimately fan out well past 30 calls in a minute.
-- The mutation RPCs keep their existing 30/60s buckets, and the Home-only
-- notice RPCs (get_saved_vendor_removal_notices / mark_..._shown) keep 30/60s —
-- neither has a Radar call site.
--
-- The bucket key changes to 'get_saved_vendors_read' so the read limit lives in
-- its own edge_function_rate_limits bucket, distinct from the mutation buckets
-- and from any rows already logged under the old 'get_saved_vendors' key.

CREATE OR REPLACE FUNCTION public.get_saved_vendors(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  vendor_id uuid,
  nickname text,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_user_phone IS NOT NULL AND btrim(p_user_phone) <> '' THEN
    v_rl_type := 'phone';
    v_rl_id := btrim(p_user_phone);
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := btrim(p_device_id);
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_saved_vendors_read', v_rl_type, v_rl_id, 120, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT sv.id, sv.vendor_id, sv.nickname, sv.category
  FROM public.saved_vendors sv
  WHERE (
    CASE
      WHEN p_user_phone IS NOT NULL AND btrim(p_user_phone) <> ''
        THEN sv.user_phone = btrim(p_user_phone)
      ELSE sv.device_id = btrim(p_device_id)
    END
  )
  ORDER BY sv.saved_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_saved_vendors(text, text) IS
  'Returns only id, vendor_id, nickname, and category for the caller''s saved neighbours. Read path shared by Home and Radar (per-card refresh) — rate-limited at 120/60s under the get_saved_vendors_read bucket; device_id is never exposed.';

REVOKE ALL ON FUNCTION public.get_saved_vendors(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_saved_vendors(text, text)
  TO anon, authenticated, service_role;
