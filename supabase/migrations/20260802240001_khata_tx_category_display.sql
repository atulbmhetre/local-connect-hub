-- Khata display traceability: return request → category label/emoji on txs.
-- Balance math and ledger scoping unchanged.

DROP FUNCTION IF EXISTS public.get_vendor_khata_transactions(uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.get_my_khata_transactions(text, uuid);

CREATE OR REPLACE FUNCTION public.get_vendor_khata_transactions(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_user_phone text,
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  amount numeric,
  note text,
  payment_mode text,
  created_at timestamptz,
  request_id uuid,
  category_id uuid,
  category_label text,
  category_emoji text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'customer_phone_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_vendor_khata_transactions', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF p_since IS NULL THEN
    RETURN QUERY
    SELECT
      t.id,
      t.amount,
      t.note,
      t.payment_mode,
      t.created_at,
      t.request_id,
      r.category_id,
      c.label,
      c.emoji
    FROM public.khata_transactions t
    LEFT JOIN public.requests r ON r.id = t.request_id
    LEFT JOIN public.categories c ON c.id = r.category_id
    WHERE t.vendor_id = p_vendor_id
      AND t.user_phone = v_phone
    ORDER BY t.created_at ASC;
  ELSE
    RETURN QUERY
    SELECT
      t.id,
      t.amount,
      t.note,
      t.payment_mode,
      t.created_at,
      t.request_id,
      r.category_id,
      c.label,
      c.emoji
    FROM public.khata_transactions t
    LEFT JOIN public.requests r ON r.id = t.request_id
    LEFT JOIN public.categories c ON c.id = r.category_id
    WHERE t.vendor_id = p_vendor_id
      AND t.user_phone = v_phone
      AND t.created_at >= p_since
    ORDER BY t.created_at DESC;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_khata_transactions(uuid, text, text, timestamptz) IS
  'OTP-off per-customer khata_transactions with optional request→category for display.';

REVOKE ALL ON FUNCTION public.get_vendor_khata_transactions(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_khata_transactions(uuid, text, text, timestamptz) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_my_khata_transactions(
  p_user_phone text,
  p_vendor_id uuid
)
RETURNS TABLE (
  id uuid,
  amount numeric,
  note text,
  payment_mode text,
  created_at timestamptz,
  request_id uuid,
  category_id uuid,
  category_label text,
  category_emoji text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit('get_my_khata_transactions', 'phone', btrim(p_user_phone), 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT
    kt.id,
    kt.amount,
    kt.note,
    kt.payment_mode,
    kt.created_at,
    kt.request_id,
    r.category_id,
    c.label,
    c.emoji
  FROM public.khata_transactions kt
  LEFT JOIN public.requests r ON r.id = kt.request_id
  LEFT JOIN public.categories c ON c.id = r.category_id
  WHERE kt.user_phone = btrim(p_user_phone)
    AND kt.vendor_id = p_vendor_id
  ORDER BY kt.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_my_khata_transactions(text, uuid) IS
  'Caller''s khata txs with one vendor, plus optional request→category for display.';

REVOKE ALL ON FUNCTION public.get_my_khata_transactions(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_khata_transactions(text, uuid) TO anon, authenticated, service_role;
