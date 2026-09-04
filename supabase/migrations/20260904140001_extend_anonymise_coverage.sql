-- Extend anonymise coverage (same 30-day grace; only add what gets cleaned).
-- Customer helper + vendor branch (vendor_devices delete).

CREATE OR REPLACE FUNCTION public._anonymise_customer_phone(
  p_original_phone text,
  p_anon_tag text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requests
  SET
    user_phone = p_anon_tag,
    delivery_address = NULL,
    message = 'Order deleted',
    intended_upi_id = NULL,
    intended_upi_qr_url = NULL,
    intended_upi_payee_id = NULL,
    claimed_upi_id = NULL,
    claimed_upi_qr_url = NULL,
    claimed_upi_payee_id = NULL,
    billed_upi_id = NULL,
    billed_upi_qr_url = NULL,
    billed_upi_payee_id = NULL,
    billed_payment_phone = NULL,
    billed_payment_snapshot_at = NULL,
    payment_screenshot_url = NULL,
    payment_utr = NULL
  WHERE user_phone = p_original_phone;

  UPDATE public.vendor_reviews
  SET
    user_phone = p_anon_tag,
    review_text = 'Review deleted'
  WHERE user_phone = p_original_phone;

  UPDATE public.feed_posts
  SET
    user_phone = p_anon_tag,
    content = 'Post deleted',
    lat = NULL,
    lng = NULL
  WHERE user_phone = p_original_phone;

  UPDATE public.feed_posts
  SET
    recommended_vendor_phone = NULL,
    recommended_vendor_id = NULL,
    recommended_vendor_name = NULL
  WHERE user_phone = p_anon_tag;

  UPDATE public.feed_replies
  SET
    user_phone = p_anon_tag,
    content = 'Reply deleted'
  WHERE user_phone = p_original_phone;

  UPDATE public.feed_flags
  SET flagged_by_phone = p_anon_tag
  WHERE flagged_by_phone = p_original_phone;

  UPDATE public.user_flags
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.order_bills
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.khata_ledger
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.khata_transactions
  SET user_phone = p_anon_tag
  WHERE user_phone = p_original_phone;

  UPDATE public.referrals
  SET referee_id = p_anon_tag
  WHERE referee_id = p_original_phone
    AND referee_type = 'user';

  -- payment_dispute_events: keep row for financial history; scrub identity.
  UPDATE public.payment_dispute_events
  SET
    user_phone = p_anon_tag,
    device_id = NULL
  WHERE user_phone = p_original_phone
     OR device_id IN (
       SELECT d.device_id
       FROM public.user_devices d
       WHERE d.user_phone = p_original_phone
     );

  -- Restrictions keyed by phone or by that phone's devices.
  DELETE FROM public.customer_payment_restrictions
  WHERE identity_key = p_original_phone
     OR identity_key IN (
       SELECT d.device_id
       FROM public.user_devices d
       WHERE d.user_phone = p_original_phone
     );

  UPDATE public.recurring_orders
  SET
    user_phone = p_anon_tag,
    delivery_address = NULL,
    customer_latitude = NULL,
    customer_longitude = NULL,
    message = NULL,
    device_id = NULL
  WHERE user_phone = p_original_phone;

  UPDATE public.support_messages
  SET
    user_phone = p_anon_tag,
    device_id = NULL,
    message = 'Message deleted'
  WHERE user_phone = p_original_phone;

  -- Leads UNIQUE(contact): delete rather than risk anon_tag collisions.
  DELETE FROM public.app_notify_leads
  WHERE contact = p_original_phone;

  UPDATE public.fcm_delivery_log
  SET target_phone = p_anon_tag
  WHERE target_phone = p_original_phone;

  -- Vendor-phone rows that use the same phone identity (vendor delete path).
  UPDATE public.vendor_call_outcomes
  SET
    vendor_phone = p_anon_tag,
    payload = NULL
  WHERE vendor_phone = p_original_phone;

  UPDATE public.bill_edit_audit
  SET vendor_phone = p_anon_tag
  WHERE vendor_phone = p_original_phone;

  UPDATE public.upi_change_alerts
  SET
    to_phone = p_anon_tag,
    old_upi = NULL,
    new_upi = NULL
  WHERE to_phone = p_original_phone;

  -- Remove device-scoped saves before user_devices DELETE
  DELETE FROM public.saved_vendors
  WHERE device_id IN (
    SELECT device_id
    FROM public.user_devices
    WHERE user_phone = p_original_phone
  );

  DELETE FROM public.user_devices
  WHERE user_phone = p_original_phone;

  DELETE FROM public.user_addresses
  WHERE user_phone = p_original_phone;

  DELETE FROM public.user_notifications
  WHERE user_phone = p_original_phone;

  DELETE FROM public.saved_vendors
  WHERE user_phone = p_original_phone;

  DELETE FROM public.saved_vendor_removal_notices
  WHERE user_phone = p_original_phone;

  DELETE FROM public.app_users
  WHERE phone = p_original_phone;

  UPDATE public.users
  SET phone = p_anon_tag
  WHERE phone = p_original_phone;
END;
$$;

COMMENT ON FUNCTION public._anonymise_customer_phone(text, text) IS
  'Remaps or deletes customer PII for one phone→anon_tag, including dispute/restriction/recurring/support/leads/FCM/UPI snapshots and vendor-phone audit rows.';

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
      DELETE FROM public.vendor_devices WHERE vendor_id = v_vendor_id;

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
  'Anonymises customer and vendor PII 30 days after deletion_requested_at. Also deletes vendor_devices on vendor anonymise.';
