-- R4: customer community posts cannot store city/nationwide reach (cap at 25 km).
-- Audience targeting ignore for customers already lives in submit_customer_feed_post;
-- this mirrors that server-side hardening for reach_radius_km.

CREATE OR REPLACE FUNCTION public.submit_customer_feed_post(
  p_user_phone text,
  p_type text,
  p_content text,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_recommended_vendor_id uuid DEFAULT NULL,
  p_recommended_vendor_name text DEFAULT NULL,
  p_recommended_vendor_phone text DEFAULT NULL,
  p_reach_radius_km numeric DEFAULT 5,
  p_target_audience text DEFAULT 'customers',
  p_target_category_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_type text;
  v_id uuid;
  v_expires_at timestamptz;
  v_audience text;
  v_reach numeric;
  c_max_customer_reach numeric := 25;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF NULLIF(trim(p_content), '') IS NULL THEN
    RAISE EXCEPTION 'content_required';
  END IF;

  -- Customer posts always target customers; ignore client attempts to set vendor targeting.
  v_audience := 'customers';
  v_type := NULLIF(trim(p_type), '');
  v_expires_at := p_expires_at;
  IF v_type IN ('announcement', 'recommendation') AND v_expires_at IS NULL THEN
    v_expires_at := now() + interval '7 days';
  END IF;

  -- Modest reach only: city-wide / nationwide (9999+) or anything above 25 → 25.
  v_reach := COALESCE(NULLIF(p_reach_radius_km, 0), 5);
  IF v_reach >= 9999 OR v_reach > c_max_customer_reach THEN
    v_reach := c_max_customer_reach;
  END IF;

  INSERT INTO public.feed_posts (
    user_phone,
    vendor_id,
    type,
    content,
    expires_at,
    image_url,
    lat,
    lng,
    reach_radius_km,
    recommended_vendor_id,
    recommended_vendor_name,
    recommended_vendor_phone,
    target_audience,
    target_category_id
  )
  VALUES (
    v_phone,
    NULL,
    v_type,
    trim(p_content),
    v_expires_at,
    NULLIF(trim(p_image_url), ''),
    p_lat,
    p_lng,
    v_reach,
    p_recommended_vendor_id,
    NULLIF(trim(p_recommended_vendor_name), ''),
    NULLIF(trim(p_recommended_vendor_phone), ''),
    v_audience,
    NULL
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
