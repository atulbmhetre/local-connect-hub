-- (a) Rate-limit get_vendor_by_phone_login by caller device AND target phone.
-- (b) Customer anonymisation waits 30 days, matching vendor grace.

DROP FUNCTION IF EXISTS public.get_vendor_by_phone_login(text);

CREATE OR REPLACE FUNCTION public.get_vendor_by_phone_login(
  p_phone text,
  p_device_id text
)
RETURNS public.vendors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vendors;
  v_digits text;
  v_device text := trim(COALESCE(p_device_id, ''));
BEGIN
  IF v_device = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;

  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) = 12 AND v_digits LIKE '91%' THEN
    v_digits := right(v_digits, 10);
  ELSIF length(v_digits) = 11 AND v_digits LIKE '1%' THEN
    v_digits := right(v_digits, 10);
  END IF;

  IF v_digits IS NULL OR length(v_digits) <> 10 THEN
    RAISE EXCEPTION 'phone_invalid';
  END IF;

  -- Caller cap: stops enumerating many phones from one device.
  IF NOT public.check_and_log_rate_limit(
    'get_vendor_by_phone_login',
    'device_id',
    v_device,
    10,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  -- Target cap: stops many devices hammering one phone (same 10/min as lookup_user_by_phone).
  IF NOT public.check_and_log_rate_limit(
    'get_vendor_by_phone_login',
    'phone',
    v_digits,
    10,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  SELECT * INTO v_row
  FROM public.vendors v
  WHERE v.phone = v_digits
    AND v.is_banned = false
    AND v.deletion_requested_at IS NULL
    AND v.phone NOT LIKE 'deleted_%'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.get_vendor_by_phone_login(text, text) IS
  'Vendor login lookup by phone; full row on success. Rate-limited 10/min per caller device_id and per target phone.';

REVOKE ALL ON FUNCTION public.get_vendor_by_phone_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vendor_by_phone_login(text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_user_deletion_status(p_phone text)
RETURNS TABLE (
  phone text,
  deletion_requested_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text := trim(COALESCE(p_phone, ''));
BEGIN
  IF v_phone = '' THEN
    RETURN;
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'get_user_deletion_status',
    'phone',
    v_phone,
    30,
    60
  ) THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  RETURN QUERY
  SELECT u.phone, u.deletion_requested_at
  FROM public.users u
  WHERE u.phone = v_phone
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_user_deletion_status(text) IS
  'OTP-off: users.deletion_requested_at by own phone (Settings cancellation UI).';

REVOKE ALL ON FUNCTION public.get_user_deletion_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_deletion_status(text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.anonymise_deleted_accounts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  original_phone text;
  anon_tag text;
  v_vendor_id uuid;
  v_shop_name text;
BEGIN
  FOR rec IN
    SELECT u.phone
    FROM public.users u
    WHERE u.deletion_requested_at IS NOT NULL
      AND NOT starts_with(u.phone, 'deleted_')
      AND u.deletion_requested_at < now() - interval '30 days'
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;

  FOR rec IN
    SELECT v.id, v.phone, v.shop_name
    FROM public.vendors v
    WHERE v.deletion_requested_at IS NOT NULL
      AND NOT starts_with(v.phone, 'deleted_')
      AND v.deletion_requested_at < now() - interval '30 days'
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);
    v_vendor_id := rec.id;
    v_shop_name := rec.shop_name;

    IF v_vendor_id IS NOT NULL THEN
      PERFORM public._purge_saved_vendors_for_account_deletion(v_vendor_id, v_shop_name);
    END IF;

    PERFORM set_config('app.via_system_rpc', 'true', true);

    UPDATE public.vendors
    SET
      phone = anon_tag,
      name = 'Deleted Vendor',
      shop_name = 'Deleted Shop',
      upi_id = NULL,
      fcm_token = NULL,
      latitude = NULL,
      longitude = NULL,
      is_active = false,
      is_banned = true,
      ban_reason = 'Account deleted',
      shop_photo_url = NULL,
      photo_selfie = NULL,
      vendor_note = NULL,
      cancel_reason_1 = NULL,
      cancel_reason_2 = NULL,
      cancel_reason_3 = NULL,
      cancel_reason_4 = NULL,
      referral_code = NULL,
      ledger_cycle_start = NULL
    WHERE phone = original_phone;

    SELECT v.id
    INTO v_vendor_id
    FROM public.vendors v
    WHERE v.phone = anon_tag;

    IF v_vendor_id IS NOT NULL THEN
      DELETE FROM public.vendor_menu_items WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_credits WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_categories WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_verification WHERE vendor_id = v_vendor_id;

      UPDATE public.categories
      SET suggested_by_vendor_id = NULL
      WHERE suggested_by_vendor_id = v_vendor_id;
    END IF;

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    DELETE FROM public.user_devices
    WHERE user_phone = original_phone;

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;

    UPDATE public.vendors
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.anonymise_deleted_accounts() IS
  'Anonymises customer and vendor PII 30 days after deletion_requested_at. Cancel via delete-account action=cancel. Vendor anonymisation still purges neighbour saved_vendors.';
