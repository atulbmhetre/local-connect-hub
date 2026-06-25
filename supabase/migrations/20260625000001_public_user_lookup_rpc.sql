CREATE OR REPLACE FUNCTION public.lookup_user_by_phone(p_phone text)
RETURNS TABLE(total_orders int, completed_orders int, trust_score double precision, warn_count int, is_banned boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT u.total_orders, u.completed_orders, u.trust_score, u.warn_count, u.is_banned
  FROM users u
  WHERE u.phone = p_phone
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_user_by_phone(text) TO anon, authenticated;
