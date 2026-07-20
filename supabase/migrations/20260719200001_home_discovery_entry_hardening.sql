-- Home & Discovery Entry hardening:
--   1) Rate-limit saved-neighbour reads and notice reads/writes.
--   2) Return only the saved-vendor columns Home consumes (never device_id).
--   3) Purge saved neighbours and queue one-time notices when a vendor is banned.

-- Changing SETOF saved_vendors to a narrow table shape requires replacing the function.
DROP FUNCTION IF EXISTS public.get_saved_vendors(text, text);

CREATE FUNCTION public.get_saved_vendors(
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
    'get_saved_vendors', v_rl_type, v_rl_id, 30, 60
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
  'Returns only id, vendor_id, nickname, and category for the caller''s saved neighbours. Rate-limited OTP-off read path; device_id is never exposed.';

REVOKE ALL ON FUNCTION public.get_saved_vendors(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_saved_vendors(text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_saved_vendor_removal_notices(
  p_user_phone text
)
RETURNS SETOF public.saved_vendor_removal_notices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_saved_vendor_removal_notices', 'phone', btrim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT n.*
  FROM public.saved_vendor_removal_notices n
  WHERE n.user_phone = btrim(p_user_phone)
    AND n.shown_at IS NULL
  ORDER BY n.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_saved_vendor_removal_notices(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_saved_vendor_removal_notices(text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_saved_vendor_removal_notices_shown(
  p_user_phone text,
  p_notice_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'mark_saved_vendor_removal_notices_shown', 'phone', btrim(p_user_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.saved_vendor_removal_notices
  SET shown_at = now()
  WHERE user_phone = btrim(p_user_phone)
    AND shown_at IS NULL
    AND (
      p_notice_ids IS NULL
      OR id = ANY (p_notice_ids)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_saved_vendor_removal_notices_shown(text, uuid[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_saved_vendor_removal_notices_shown(text, uuid[])
  TO anon, authenticated, service_role;

ALTER TABLE public.saved_vendor_removal_notices
  DROP CONSTRAINT IF EXISTS saved_vendor_removal_notices_reason_check;
ALTER TABLE public.saved_vendor_removal_notices
  ADD CONSTRAINT saved_vendor_removal_notices_reason_check
  CHECK (reason IN ('category_removed', 'account_deleted', 'vendor_banned'));

CREATE OR REPLACE FUNCTION public._purge_saved_vendors_for_vendor_ban(
  p_vendor_id uuid,
  p_shop_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.saved_vendor_removal_notices (
    user_phone,
    shop_name,
    category_label,
    reason
  )
  SELECT DISTINCT
    btrim(sv.user_phone),
    COALESCE(NULLIF(btrim(p_shop_name), ''), 'Shop'),
    sv.category,
    'vendor_banned'
  FROM public.saved_vendors sv
  WHERE sv.vendor_id = p_vendor_id
    AND sv.user_phone IS NOT NULL
    AND btrim(sv.user_phone) <> '';

  DELETE FROM public.saved_vendors
  WHERE vendor_id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public._purge_saved_vendors_for_vendor_ban(uuid, text)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._queue_saved_vendor_notice_on_ban()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_banned, false)
     AND NOT COALESCE(OLD.is_banned, false)
  THEN
    PERFORM public._purge_saved_vendors_for_vendor_ban(NEW.id, NEW.shop_name);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._queue_saved_vendor_notice_on_ban()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS vendors_saved_vendor_notice_on_ban ON public.vendors;
CREATE TRIGGER vendors_saved_vendor_notice_on_ban
AFTER UPDATE OF is_banned ON public.vendors
FOR EACH ROW
WHEN (NEW.is_banned = true AND OLD.is_banned IS DISTINCT FROM true)
EXECUTE FUNCTION public._queue_saved_vendor_notice_on_ban();

COMMENT ON FUNCTION public._queue_saved_vendor_notice_on_ban() IS
  'Purges saved_vendors and queues vendor_banned Home notices on the first transition to banned.';
