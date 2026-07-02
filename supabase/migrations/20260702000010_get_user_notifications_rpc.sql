-- OTP-off safe read path for notifications (RLS-safe SECURITY DEFINER).

CREATE OR REPLACE FUNCTION public.get_user_notifications(
  p_user_phone text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_limit integer;
BEGIN
  v_phone := NULLIF(trim(COALESCE(p_user_phone, '')), '');
  IF v_phone IS NULL AND NULLIF(trim(COALESCE(p_device_id, '')), '') IS NOT NULL THEN
    SELECT u.phone
    INTO v_phone
    FROM public.users u
    WHERE u.device_id = p_device_id
    ORDER BY u.last_active DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 50), 100), 1);

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_data ORDER BY is_read ASC, created_at DESC)
      FROM (
        SELECT
          jsonb_build_object(
            'id', n.id,
            'user_phone', n.user_phone,
            'type', n.type,
            'title', n.title,
            'body', n.body,
            'route', n.route,
            'route_params', n.route_params,
            'is_informational', n.is_informational,
            'is_read', n.is_read,
            'read_at', n.read_at,
            'created_at', n.created_at
          ) AS row_data,
          n.is_read,
          n.created_at
        FROM public.user_notifications n
        WHERE n.user_phone = v_phone
        ORDER BY n.is_read ASC, n.created_at DESC
        LIMIT v_limit
      ) sub
    ),
    '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_notifications(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_notifications(text, text, integer) TO anon, authenticated;
