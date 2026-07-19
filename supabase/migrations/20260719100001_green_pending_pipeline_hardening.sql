-- Green-Pending pipeline hardening (vendor onboarding checklist -> admin approval).
--
-- 1) vendor_update_own: verification_status is now field_not_allowed (confirmed
--    live: a vendor could self-set green_pending via the generic patch). The two
--    legitimate self-downgrades move server-side:
--      * phone/UPI change -> verification_status := 'identity_linked'
--        (previously client-sent in the same patch);
--      * shop-location change downgrade folds into
--        vendor_clear_category_photo_verifications (the location path already
--        calls it). NOT auto-applied on lat/lng patches inside vendor_update_own
--        because background live-location pings also patch lat/lng.
-- 2) vendor_promote_green_pending / vendor_promote_category_green_pending:
--    selfie (vendors.photo_selfie) is now required, matching the checklist UI.
--    Category promote now RETURNS boolean (was void) so the client can tell
--    whether promotion actually happened (drives the admin notification).
-- 3) admin_verify_vendor / admin_verify_vendor_category: server-side status
--    gate - approval only from green_pending or business_verified
--    (defense-in-depth behind the 13-checkbox admin UI).
-- 4) Observability: green_pending_vendors count in get_admin_dashboard_stats +
--    new get_admin_green_pending_stats() for the Admin Health card.

-- ── 1. vendor_update_own: block verification_status; server-side downgrade ───

CREATE OR REPLACE FUNCTION public.vendor_update_own(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'patch_required';
  END IF;

  IF p_patch ? 'discoverable' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  IF p_patch ? 'upi_verified' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  -- Verification tier: promote RPCs (vendor_promote_green_pending,
  -- vendor_promote_category_green_pending) and admin verify/unverify RPCs only.
  IF p_patch ? 'verification_status' THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  -- Subscription / billing fields: Razorpay webhook + check-vendor-subscriptions only.
  IF p_patch ? 'subscription_status'
     OR p_patch ? 'subscription_id'
     OR p_patch ? 'grace_ends_at'
  THEN
    RAISE EXCEPTION 'field_not_allowed';
  END IF;

  UPDATE public.vendors v
  SET
    name = CASE WHEN p_patch ? 'name' THEN NULLIF(trim(p_patch->>'name'), '') ELSE v.name END,
    vendor_note = CASE WHEN p_patch ? 'vendor_note' THEN NULLIF(p_patch->>'vendor_note', '') ELSE v.vendor_note END,
    service_radius_km = CASE WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::integer ELSE v.service_radius_km END,
    latitude = CASE WHEN p_patch ? 'latitude' THEN (p_patch->>'latitude')::double precision ELSE v.latitude END,
    longitude = CASE WHEN p_patch ? 'longitude' THEN (p_patch->>'longitude')::double precision ELSE v.longitude END,
    profile_status = CASE WHEN p_patch ? 'profile_status' THEN p_patch->>'profile_status' ELSE v.profile_status END,
    ledger_cycle_start = CASE
      WHEN p_patch ? 'ledger_cycle_start' AND p_patch->'ledger_cycle_start' IS NULL THEN NULL
      WHEN p_patch ? 'ledger_cycle_start' THEN (p_patch->>'ledger_cycle_start')::date
      ELSE v.ledger_cycle_start
    END,
    khata_amber_limit = CASE WHEN p_patch ? 'khata_amber_limit' THEN (p_patch->>'khata_amber_limit')::numeric ELSE v.khata_amber_limit END,
    khata_red_limit = CASE WHEN p_patch ? 'khata_red_limit' THEN (p_patch->>'khata_red_limit')::numeric ELSE v.khata_red_limit END,
    cancel_reason_1 = CASE WHEN p_patch ? 'cancel_reason_1' THEN NULLIF(p_patch->>'cancel_reason_1', '') ELSE v.cancel_reason_1 END,
    cancel_reason_2 = CASE WHEN p_patch ? 'cancel_reason_2' THEN NULLIF(p_patch->>'cancel_reason_2', '') ELSE v.cancel_reason_2 END,
    cancel_reason_3 = CASE WHEN p_patch ? 'cancel_reason_3' THEN NULLIF(p_patch->>'cancel_reason_3', '') ELSE v.cancel_reason_3 END,
    cancel_reason_4 = CASE WHEN p_patch ? 'cancel_reason_4' THEN NULLIF(p_patch->>'cancel_reason_4', '') ELSE v.cancel_reason_4 END,
    -- subscription_status / subscription_id / grace_ends_at intentionally omitted (field_not_allowed)
    last_updated = CASE
      WHEN p_patch ? 'last_updated' THEN (p_patch->>'last_updated')::timestamptz
      ELSE v.last_updated
    END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch->>'is_active')::boolean ELSE v.is_active END,
    fcm_token = CASE WHEN p_patch ? 'fcm_token' THEN NULLIF(p_patch->>'fcm_token', '') ELSE v.fcm_token END,
    shop_name = CASE WHEN p_patch ? 'shop_name' THEN NULLIF(p_patch->>'shop_name', '') ELSE v.shop_name END,
    category = CASE WHEN p_patch ? 'category' THEN NULLIF(p_patch->>'category', '') ELSE v.category END,
    service_mode = CASE WHEN p_patch ? 'service_mode' THEN NULLIF(p_patch->>'service_mode', '') ELSE v.service_mode END,
    vendor_type = CASE WHEN p_patch ? 'vendor_type' THEN NULLIF(p_patch->>'vendor_type', '') ELSE v.vendor_type END,
    base_type = CASE WHEN p_patch ? 'base_type' THEN NULLIF(p_patch->>'base_type', '') ELSE v.base_type END,
    serves_at_vendor_place = CASE
      WHEN p_patch ? 'serves_at_vendor_place' THEN (p_patch->>'serves_at_vendor_place')::boolean
      ELSE v.serves_at_vendor_place
    END,
    serves_at_customer_place = CASE
      WHEN p_patch ? 'serves_at_customer_place' THEN (p_patch->>'serves_at_customer_place')::boolean
      ELSE v.serves_at_customer_place
    END,
    phone = CASE WHEN p_patch ? 'phone' THEN NULLIF(p_patch->>'phone', '') ELSE v.phone END,
    upi_id = CASE WHEN p_patch ? 'upi_id' THEN NULLIF(p_patch->>'upi_id', '') ELSE v.upi_id END,
    is_manual_verified = CASE WHEN p_patch ? 'is_manual_verified' THEN (p_patch->>'is_manual_verified')::boolean ELSE v.is_manual_verified END,
    -- Server-side identity downgrade (was a client-sent verification_status patch):
    -- changing phone or UPI invalidates the verified tier.
    verification_status = CASE
      WHEN (
        p_patch ? 'phone'
        AND NULLIF(trim(p_patch->>'phone'), '') IS DISTINCT FROM v.phone
      ) OR (
        p_patch ? 'upi_id'
        AND NULLIF(trim(COALESCE(p_patch->>'upi_id', '')), '')
          IS DISTINCT FROM NULLIF(trim(COALESCE(v.upi_id, '')), '')
      )
      THEN 'identity_linked'
      ELSE v.verification_status
    END,
    shop_photo_url = CASE
      WHEN p_patch ? 'shop_photo_url' AND p_patch->'shop_photo_url' IS NULL THEN NULL
      WHEN p_patch ? 'shop_photo_url' THEN NULLIF(p_patch->>'shop_photo_url', '')
      ELSE v.shop_photo_url
    END,
    upi_verified = CASE
      WHEN p_patch ? 'upi_id'
        AND NULLIF(trim(COALESCE(p_patch->>'upi_id', '')), '')
          IS DISTINCT FROM NULLIF(trim(COALESCE(v.upi_id, '')), '')
      THEN false
      ELSE v.upi_verified
    END,
    photo_selfie = CASE
      WHEN p_patch ? 'photo_selfie' AND p_patch->'photo_selfie' IS NULL THEN NULL
      WHEN p_patch ? 'photo_selfie' THEN NULLIF(p_patch->>'photo_selfie', '')
      ELSE v.photo_selfie
    END,
    gps_match_distance = CASE WHEN p_patch ? 'gps_match_distance' THEN (p_patch->>'gps_match_distance')::integer ELSE v.gps_match_distance END
  WHERE v.id = p_vendor_id
    AND v.phone = trim(p_vendor_phone);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_patch ? 'base_type' AND NOT (p_patch ? 'vendor_type') THEN
    UPDATE public.vendors v
    SET vendor_type = CASE v.base_type
      WHEN 'shop' THEN 'shop'
      WHEN 'home' THEN 'home'
      WHEN 'none' THEN 'visiting'
      ELSE v.vendor_type
    END
    WHERE v.id = p_vendor_id
      AND v.phone = trim(p_vendor_phone);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.vendor_update_own(uuid, text, jsonb) IS
  'Vendor self-update. Blocks discoverable, upi_verified, verification_status, subscription fields. Phone/UPI change auto-downgrades verification_status to identity_linked.';

REVOKE ALL ON FUNCTION public.vendor_update_own(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_own(uuid, text, jsonb) TO anon, authenticated, service_role;

-- ── 2. vendor_clear_category_photo_verifications: absorb account downgrade ───
-- The Settings shop-location-change path previously patched
-- verification_status/shop_photo_url/is_manual_verified client-side alongside
-- calling this RPC for the category rows. With verification_status blocked in
-- the generic patch, the account-level downgrade lives here (identity-checked,
-- downgrade-only). via_system_rpc lets the is_manual_verified reset pass the
-- direct-admin-column-write trigger.

CREATE OR REPLACE FUNCTION public.vendor_clear_category_photo_verifications(
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  PERFORM set_config('app.via_system_rpc', 'true', true);

  UPDATE public.vendor_categories
  SET
    shop_photo_url = NULL,
    gps_match_distance = NULL,
    verification_status = 'identity_linked',
    is_manual_verified = false
  WHERE vendor_id = p_vendor_id;

  UPDATE public.vendors
  SET
    shop_photo_url = NULL,
    gps_match_distance = NULL,
    verification_status = 'identity_linked',
    is_manual_verified = false
  WHERE id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.vendor_clear_category_photo_verifications(uuid, text) IS
  'Shop-location change: clears photo verification and downgrades to identity_linked for the account and every business (downgrade-only, identity-checked).';

REVOKE ALL ON FUNCTION public.vendor_clear_category_photo_verifications(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_clear_category_photo_verifications(uuid, text)
  TO anon, authenticated, service_role;

-- ── 3. Promote RPCs: selfie now required ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_promote_green_pending(p_vendor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendors v
  SET verification_status = 'green_pending'
  WHERE v.id = p_vendor_id
    AND v.verification_status = 'business_verified'
    AND v.is_manual_verified IS NOT TRUE
    AND v.shop_photo_url IS NOT NULL
    AND v.photo_selfie IS NOT NULL
    AND trim(v.photo_selfie) <> ''
    AND v.upi_verified IS TRUE
    AND regexp_replace(COALESCE(v.phone, ''), '[\s-]', '', 'g') ~ '^(\+?91)?[6-9][0-9]{9}$';

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.vendor_promote_green_pending(uuid) IS
  'Marks green_pending when full green criteria met incl. selfie (all checks server-side; idempotent).';

-- Return type changes void -> boolean: explicit DROP required (42P13).
DROP FUNCTION IF EXISTS public.vendor_promote_category_green_pending(uuid, uuid);

CREATE FUNCTION public.vendor_promote_category_green_pending(
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upi boolean;
  v_selfie text;
BEGIN
  SELECT COALESCE(upi_verified, false), photo_selfie
  INTO v_upi, v_selfie
  FROM public.vendors WHERE id = p_vendor_id;

  IF NOT COALESCE(v_upi, false) THEN
    RETURN false;
  END IF;
  IF v_selfie IS NULL OR trim(v_selfie) = '' THEN
    RETURN false;
  END IF;

  UPDATE public.vendor_categories
  SET verification_status = 'green_pending'
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id
    AND is_manual_verified = false
    AND shop_photo_url IS NOT NULL
    AND trim(shop_photo_url) <> ''
    AND COALESCE(verification_status, '') IS DISTINCT FROM 'green_pending';

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.vendor_promote_category_green_pending(uuid, uuid) IS
  'Marks a business green_pending when photo + UPI + selfie done; returns whether promotion happened.';

REVOKE ALL ON FUNCTION public.vendor_promote_category_green_pending(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_promote_category_green_pending(uuid, uuid)
  TO anon, authenticated, service_role;

-- ── 4. Admin verify RPCs: require ready status server-side ───────────────────

CREATE OR REPLACE FUNCTION public.admin_verify_vendor_category(
  p_admin_phone text,
  p_vendor_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT verification_status INTO v_status
  FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  -- Defense-in-depth behind the admin UI checklist: approval only for
  -- businesses that actually completed verification.
  IF COALESCE(v_status, '') NOT IN ('green_pending', 'business_verified') THEN
    RAISE EXCEPTION 'category_not_ready';
  END IF;

  UPDATE public.vendor_categories
  SET is_manual_verified = true
  WHERE vendor_id = p_vendor_id
    AND category_id = p_category_id;

  -- Keep account flag true if any business is admin-verified (legacy readers).
  UPDATE public.vendors v
  SET is_manual_verified = EXISTS (
    SELECT 1 FROM public.vendor_categories vc
    WHERE vc.vendor_id = v.id AND vc.is_manual_verified = true
  )
  WHERE v.id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.admin_verify_vendor_category(text, uuid, uuid) IS
  'Admin approval for one business; requires verification_status green_pending or business_verified.';

CREATE OR REPLACE FUNCTION public.admin_verify_vendor(
  p_admin_phone text,
  p_vendor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  SELECT verification_status INTO v_status
  FROM public.vendors
  WHERE id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor not found';
  END IF;

  IF COALESCE(v_status, '') NOT IN ('green_pending', 'business_verified') THEN
    RAISE EXCEPTION 'vendor_not_ready';
  END IF;

  UPDATE public.vendors
  SET is_manual_verified = true
  WHERE id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.admin_verify_vendor(text, uuid) IS
  'Legacy account-level admin approval; requires verification_status green_pending or business_verified.';

-- ── 5. Observability: green_pending counts ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_start_of_today timestamptz;
  v_start_of_week timestamptz;
  v_stuck_cutoff timestamptz;
  v_total_orders integer;
  v_orders_today integer;
  v_orders_this_week integer;
  v_total_vendors integer;
  v_total_customers integer;
  v_stuck_orders integer;
  v_active_vendors_today integer;
  v_new_vendors_this_week integer;
  v_unverified_vendors integer;
  v_green_pending_vendors integer;
  v_risky_users integer;
  v_total_referrals integer;
  v_avg_vendor_rating numeric;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  v_start_of_today := date_trunc('day', v_now AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_start_of_week := v_start_of_today - interval '7 days';
  v_stuck_cutoff := v_now - interval '48 hours';

  SELECT count(*)::integer INTO v_total_orders FROM public.requests;
  SELECT count(*)::integer INTO v_orders_today
  FROM public.requests WHERE created_at >= v_start_of_today;
  SELECT count(*)::integer INTO v_orders_this_week
  FROM public.requests WHERE created_at >= v_start_of_week;

  SELECT count(*)::integer INTO v_total_vendors FROM public.vendors;
  SELECT count(*)::integer INTO v_total_customers FROM public.app_users;
  SELECT count(*)::integer INTO v_stuck_orders
  FROM public.requests
  WHERE status IN ('sent', 'accepted') AND created_at < v_stuck_cutoff;
  SELECT count(*)::integer INTO v_active_vendors_today
  FROM public.vendors
  WHERE is_active = true AND last_updated >= v_start_of_today;
  SELECT count(*)::integer INTO v_new_vendors_this_week
  FROM public.vendors WHERE created_at >= v_start_of_week;
  SELECT count(*)::integer INTO v_unverified_vendors
  FROM public.vendors WHERE is_manual_verified = false;

  -- Vendors ready for admin review: account or any business at green_pending
  -- without an admin approval yet.
  SELECT count(*)::integer INTO v_green_pending_vendors
  FROM public.vendors v
  WHERE (v.verification_status = 'green_pending' AND v.is_manual_verified = false)
     OR EXISTS (
       SELECT 1 FROM public.vendor_categories vc
       WHERE vc.vendor_id = v.id
         AND vc.verification_status = 'green_pending'
         AND vc.is_manual_verified = false
     );

  SELECT count(*)::integer INTO v_risky_users
  FROM public.users WHERE trust_score < 25 AND is_banned = false;
  SELECT count(*)::integer INTO v_total_referrals FROM public.referrals;

  SELECT round(avg(avg_rating)::numeric, 1) INTO v_avg_vendor_rating
  FROM public.vendors
  WHERE avg_rating > 0 AND is_active = true;

  RETURN jsonb_build_object(
    'total_orders', COALESCE(v_total_orders, 0),
    'orders_today', COALESCE(v_orders_today, 0),
    'orders_this_week', COALESCE(v_orders_this_week, 0),
    'total_vendors', COALESCE(v_total_vendors, 0),
    'total_customers', COALESCE(v_total_customers, 0),
    'stuck_orders', COALESCE(v_stuck_orders, 0),
    'active_vendors_today', COALESCE(v_active_vendors_today, 0),
    'new_vendors_this_week', COALESCE(v_new_vendors_this_week, 0),
    'unverified_vendors', COALESCE(v_unverified_vendors, 0),
    'green_pending_vendors', COALESCE(v_green_pending_vendors, 0),
    'risky_users', COALESCE(v_risky_users, 0),
    'total_referrals', COALESCE(v_total_referrals, 0),
    'avg_vendor_rating', COALESCE(v_avg_vendor_rating, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_green_pending_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_pending bigint;
  v_category_pending bigint;
  v_vendors_ready bigint;
BEGIN
  IF NOT public.is_admin_session()
     AND coalesce(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(*) INTO v_account_pending
  FROM public.vendors
  WHERE verification_status = 'green_pending'
    AND is_manual_verified = false;

  SELECT count(*) INTO v_category_pending
  FROM public.vendor_categories
  WHERE verification_status = 'green_pending'
    AND is_manual_verified = false;

  SELECT count(*) INTO v_vendors_ready
  FROM public.vendors v
  WHERE (v.verification_status = 'green_pending' AND v.is_manual_verified = false)
     OR EXISTS (
       SELECT 1 FROM public.vendor_categories vc
       WHERE vc.vendor_id = v.id
         AND vc.verification_status = 'green_pending'
         AND vc.is_manual_verified = false
     );

  RETURN jsonb_build_object(
    'account_pending', coalesce(v_account_pending, 0),
    'category_pending', coalesce(v_category_pending, 0),
    'vendors_ready', coalesce(v_vendors_ready, 0)
  );
END;
$$;

COMMENT ON FUNCTION public.get_admin_green_pending_stats() IS
  'Admin health: vendors/businesses stuck at green_pending awaiting admin review.';

REVOKE ALL ON FUNCTION public.get_admin_green_pending_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_green_pending_stats() TO anon, authenticated, service_role;
