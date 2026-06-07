-- Account deletion: anonymise customer data immediately; vendor profiles after 30 days.
-- Runs daily at 02:00 via pg_cron.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz DEFAULT NULL;

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz DEFAULT NULL;

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
    message = 'Order deleted'
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

  DELETE FROM public.user_devices
  WHERE user_phone = p_original_phone;

  DELETE FROM public.user_addresses
  WHERE user_phone = p_original_phone;

  DELETE FROM public.user_notifications
  WHERE user_phone = p_original_phone;

  DELETE FROM public.saved_vendors
  WHERE user_phone = p_original_phone;

  DELETE FROM public.app_users
  WHERE phone = p_original_phone;

  UPDATE public.users
  SET phone = p_anon_tag
  WHERE phone = p_original_phone;
END;
$$;

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
BEGIN
  -- Customers: immediate when deletion requested and not an active (non-deletion) vendor
  FOR rec IN
    SELECT u.phone
    FROM public.users u
    WHERE u.deletion_requested_at IS NOT NULL
      AND NOT starts_with(u.phone, 'deleted_')
      AND u.phone NOT IN (
        SELECT v.phone
        FROM public.vendors v
        WHERE v.deletion_requested_at IS NULL
      )
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);
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
      ban_reason = 'Account deleted'
    WHERE phone = original_phone;

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    DELETE FROM public.user_devices
    WHERE user_phone = original_phone;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.anonymise_deleted_accounts() IS
  'Anonymises customer PII immediately on deletion request; vendor profiles after 30 days.';

SELECT cron.schedule(
  'anonymise-deleted-accounts',
  '0 2 * * *',
  $$SELECT anonymise_deleted_accounts();$$
);
