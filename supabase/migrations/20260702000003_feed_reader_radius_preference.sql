-- Reader feed discovery radius preference (Change 1).

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS feed_discovery_radius_km integer DEFAULT 5;

COMMENT ON COLUMN public.app_users.feed_discovery_radius_km IS
  'Reader-side feed discovery cap (km). NULL = city-wide (no reader cap). Default 5.';

-- Align legacy 2 km backfill from 20260702000001 to 5 km default.
UPDATE public.feed_posts
SET reach_radius_km = 5
WHERE reach_radius_km = 2;

CREATE OR REPLACE FUNCTION public.get_feed_preferences(p_user_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_radius integer;
  v_found boolean := false;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  SELECT au.feed_discovery_radius_km
  INTO v_radius
  FROM public.app_users au
  WHERE au.phone = v_phone;

  v_found := FOUND;

  RETURN jsonb_build_object(
    'feed_discovery_radius_km',
    CASE WHEN v_found THEN v_radius ELSE 5 END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_feed_discovery_radius(
  p_user_phone text,
  p_radius_km integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_radius_km IS NOT NULL AND p_radius_km <= 0 THEN
    RAISE EXCEPTION 'invalid_radius';
  END IF;

  INSERT INTO public.app_users (phone, feed_discovery_radius_km)
  VALUES (v_phone, p_radius_km)
  ON CONFLICT (phone) DO UPDATE
  SET feed_discovery_radius_km = EXCLUDED.feed_discovery_radius_km;
END;
$$;

REVOKE ALL ON FUNCTION public.get_feed_preferences(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feed_preferences(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.set_feed_discovery_radius(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_feed_discovery_radius(text, integer) TO anon, authenticated;
