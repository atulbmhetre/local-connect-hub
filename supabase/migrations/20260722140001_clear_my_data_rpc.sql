-- Clear My Data: atomic customer-initiated wipe of preferences/PII while retaining
-- financial records, referrals/credits, abuse flags, and account standing.

CREATE OR REPLACE FUNCTION public.clear_my_data(
  p_user_phone text,
  p_device_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_vendor_id uuid;
BEGIN
  v_phone := NULLIF(trim(p_user_phone), '');
  IF NOT public._customer_identity_ok(p_device_id, v_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'clear_my_data', 'phone', v_phone, 5, 3600
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- ── CLEAR: notifications, addresses, devices, profile prefs ───────────────
  DELETE FROM public.user_notifications
  WHERE user_phone = v_phone;

  DELETE FROM public.user_addresses
  WHERE user_phone = v_phone;

  DELETE FROM public.saved_vendor_removal_notices
  WHERE user_phone = v_phone;

  DELETE FROM public.saved_vendors
  WHERE user_phone = v_phone
     OR device_id IN (
       SELECT ud.device_id
       FROM public.user_devices ud
       WHERE ud.user_phone = v_phone
     );

  DELETE FROM public.user_devices
  WHERE user_phone = v_phone;

  DELETE FROM public.app_users
  WHERE phone = v_phone;

  -- ── CLEAR: feed content (keep stub rows for counts/moderation history) ───
  UPDATE public.feed_posts
  SET
    content = 'Post cleared',
    lat = NULL,
    lng = NULL,
    image_url = NULL
  WHERE user_phone = v_phone
     OR vendor_id IN (SELECT v.id FROM public.vendors v WHERE v.phone = v_phone);

  UPDATE public.feed_replies
  SET content = 'Reply cleared'
  WHERE user_phone = v_phone;

  DELETE FROM public.feed_flags
  WHERE flagged_by_phone = v_phone;

  -- ── CLEAR: review text only (rating row kept for vendor aggregates) ───────
  UPDATE public.vendor_reviews
  SET review_text = NULL
  WHERE user_phone = v_phone;

  -- ── CLEAR: vendor push tokens on any vendor account tied to this phone ────
  FOR v_vendor_id IN
    SELECT v.id FROM public.vendors v WHERE v.phone = v_phone
  LOOP
    DELETE FROM public.vendor_devices WHERE vendor_id = v_vendor_id;
    UPDATE public.vendors
    SET fcm_token = NULL
    WHERE id = v_vendor_id;
  END LOOP;

  -- ── RETAIN (explicitly untouched): ────────────────────────────────────────
  -- requests, order_bills, order_items, bill_edit_audit,
  -- khata_ledger, khata_transactions,
  -- referrals, vendor_credits,
  -- users (phone, is_banned, warn_count, trust_score, deletion flags),
  -- user_flags (customer no-show / fake-order reports for abuse prevention)
END;
$$;

COMMENT ON FUNCTION public.clear_my_data(text, text) IS
  'Customer-initiated partial wipe: clears prefs, addresses, notifications, feed/review text, saved neighbours, and device tokens. Retains orders, bills, khata, referrals/credits, users standing/flags, and user_flags abuse records.';

REVOKE ALL ON FUNCTION public.clear_my_data(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_my_data(text, text) TO anon, authenticated, service_role;
