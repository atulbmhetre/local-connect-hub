-- Admin view of community recommendation posts (vendor leads).

CREATE OR REPLACE FUNCTION public.get_recommendations_for_admin(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_vendor_id uuid;
  v_super_admin boolean;
BEGIN
  v_phone := NULLIF(trim(p_admin_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_super_admin := public.is_admin_phone(v_phone);
  v_vendor_id := NULL;

  IF NOT v_super_admin THEN
    SELECT v.id
    INTO v_vendor_id
    FROM public.vendors v
    WHERE v.phone = v_phone
      AND v.is_active = true
    ORDER BY v.last_updated DESC NULLS LAST
    LIMIT 1;

    IF v_vendor_id IS NULL THEN
      RAISE EXCEPTION 'unauthorized';
    END IF;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_data ORDER BY created_at DESC)
      FROM (
        SELECT
          jsonb_build_object(
            'id', fp.id,
            'user_phone', fp.user_phone,
            'content', fp.content,
            'recommended_vendor_id', fp.recommended_vendor_id,
            'recommended_vendor_name', fp.recommended_vendor_name,
            'recommended_vendor_phone', fp.recommended_vendor_phone,
            'reach_radius_km', fp.reach_radius_km,
            'created_at', fp.created_at,
            'expires_at', fp.expires_at
          ) AS row_data,
          fp.created_at
        FROM public.feed_posts fp
        WHERE fp.type = 'recommendation'
          AND fp.is_hidden = false
          AND (
            v_super_admin
            OR fp.recommended_vendor_id = v_vendor_id
            OR (
              fp.recommended_vendor_phone IS NOT NULL
              AND trim(fp.recommended_vendor_phone) = v_phone
            )
          )
        ORDER BY fp.created_at DESC
        LIMIT 100
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_recommendations_for_admin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_recommendations_for_admin(text) TO anon, authenticated;
