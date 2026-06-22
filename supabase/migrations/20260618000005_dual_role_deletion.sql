-- Dual-role deletion: customer anonymization proceeds even when vendor grace is active.

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
BEGIN
  -- Customers: immediate when deletion requested (vendor grace handled separately)
  FOR rec IN
    SELECT u.phone
    FROM public.users u
    WHERE u.deletion_requested_at IS NOT NULL
      AND NOT starts_with(u.phone, 'deleted_')
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;

  -- Vendors: after 30-day grace period
  FOR rec IN
    SELECT v.phone
    FROM public.vendors v
    WHERE v.deletion_requested_at IS NOT NULL
      AND NOT starts_with(v.phone, 'deleted_')
      AND v.deletion_requested_at < now() - interval '30 days'
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

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
  'Anonymises customer PII immediately on deletion request; vendor profiles after 30 days. Dual-role: customer immediate + vendor grace.';
