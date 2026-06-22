-- ============================================================
-- PHASE C TIER 2 — Identity/trust tables RLS
-- Uses public.auth_user_phone() from Tier 1 migration
-- ============================================================

-- ── users ────────────────────────────────────────────────────
-- Private — only owner sees own row. Admin via service role.
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON users;

CREATE POLICY users_owner ON users
  FOR ALL
  TO anon, authenticated
  USING (phone = public.auth_user_phone())
  WITH CHECK (phone = public.auth_user_phone());

-- ── user_devices ─────────────────────────────────────────────
-- Private — only owner sees own device rows.
-- Edge functions (FCM token save) use service role — bypass RLS.
ALTER TABLE user_devices DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON user_devices;

CREATE POLICY user_devices_owner ON user_devices
  FOR ALL
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

-- ── user_notifications ───────────────────────────────────────
-- Private — only owner sees own notifications.
-- Edge functions insert via service role — bypass RLS.
ALTER TABLE user_notifications DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON user_notifications;
DROP POLICY IF EXISTS user_notifications_delete ON user_notifications;
DROP POLICY IF EXISTS user_notifications_insert ON user_notifications;
DROP POLICY IF EXISTS user_notifications_select ON user_notifications;
DROP POLICY IF EXISTS user_notifications_update ON user_notifications;

CREATE POLICY user_notifications_owner ON user_notifications
  FOR ALL
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

-- ── app_users ────────────────────────────────────────────────
-- Private — owner reads/updates own row.
-- Insert allowed for authenticated user registering themselves.
ALTER TABLE app_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_users_insert ON app_users;
DROP POLICY IF EXISTS app_users_select ON app_users;
DROP POLICY IF EXISTS app_users_update ON app_users;

CREATE POLICY app_users_owner ON app_users
  FOR ALL
  TO anon, authenticated
  USING (phone = public.auth_user_phone())
  WITH CHECK (phone = public.auth_user_phone());

-- ── vendor_reviews ───────────────────────────────────────────
-- SELECT public — Radar shows ratings to all users.
-- INSERT by customer who owns the order (user_phone match).
-- UPDATE by vendor for response only (vendor_response field).
-- DELETE by admin via service role only.
ALTER TABLE vendor_reviews DISABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON vendor_reviews;

-- Anyone can read reviews (public trust signal)
CREATE POLICY vendor_reviews_public_read ON vendor_reviews
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Customer inserts their own review
CREATE POLICY vendor_reviews_customer_insert ON vendor_reviews
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (user_phone = public.auth_user_phone());

-- Vendor updates only their response fields
CREATE POLICY vendor_reviews_vendor_response ON vendor_reviews
  FOR UPDATE
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT id FROM vendors WHERE phone = public.auth_user_phone()
    )
  )
  WITH CHECK (
    vendor_id IN (
      SELECT id FROM vendors WHERE phone = public.auth_user_phone()
    )
  );

-- ── vendor_verification ──────────────────────────────────────
-- Vendor reads own verification rows.
-- All writes via service role RPCs (SECURITY DEFINER) — bypass RLS.
ALTER TABLE vendor_verification DISABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_verification ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can insert vendor verification" ON vendor_verification;
DROP POLICY IF EXISTS "Public can read vendor verification" ON vendor_verification;
DROP POLICY IF EXISTS "Public can update vendor verification" ON vendor_verification;

CREATE POLICY vendor_verification_owner ON vendor_verification
  FOR SELECT
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT id FROM vendors WHERE phone = public.auth_user_phone()
    )
  );

-- ── vendor_categories ────────────────────────────────────────
-- SELECT approved categories — public (Radar needs this).
-- INSERT/UPDATE/DELETE — vendor owns their own categories.
ALTER TABLE vendor_categories DISABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can delete vendor categories" ON vendor_categories;
DROP POLICY IF EXISTS "Public can insert vendor categories" ON vendor_categories;
DROP POLICY IF EXISTS "Public can read approved vendor categories" ON vendor_categories;
DROP POLICY IF EXISTS "Public can update vendor categories" ON vendor_categories;

-- Public read of approved categories (Radar search needs this)
CREATE POLICY vendor_categories_public_read ON vendor_categories
  FOR SELECT
  TO anon, authenticated
  USING (status = 'approved');

-- Vendor manages own categories
CREATE POLICY vendor_categories_owner ON vendor_categories
  FOR ALL
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT id FROM vendors WHERE phone = public.auth_user_phone()
    )
  )
  WITH CHECK (
    vendor_id IN (
      SELECT id FROM vendors WHERE phone = public.auth_user_phone()
    )
  );

-- ── referrals ────────────────────────────────────────────────
-- Vendor reads own referrals.
-- process-vendor-referral edge function inserts/updates via service role.
ALTER TABLE referrals DISABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS referrals_insert ON referrals;
DROP POLICY IF EXISTS referrals_select ON referrals;
DROP POLICY IF EXISTS referrals_update ON referrals;

CREATE POLICY referrals_owner ON referrals
  FOR SELECT
  TO anon, authenticated
  USING (
    referrer_vendor_id IN (
      SELECT id FROM vendors WHERE phone = public.auth_user_phone()
    )
  );

-- ── vendors ──────────────────────────────────────────────────
-- SELECT public — Radar queries all vendors.
-- ALL (insert/update/delete) — vendor owns own row only.
-- Admin writes blocked by trigger (Session 47) — must go via RPC.
ALTER TABLE vendors DISABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public Access" ON vendors;

-- Anyone can read vendors (Radar, feed, everywhere)
CREATE POLICY vendors_public_read ON vendors
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Vendor writes own row only
CREATE POLICY vendors_owner ON vendors
  FOR ALL
  TO anon, authenticated
  USING (phone = public.auth_user_phone())
  WITH CHECK (phone = public.auth_user_phone());

-- ── admin_actions ────────────────────────────────────────────
-- Admin reads own audit log only.
-- All writes via logAdminAction() RPC (SECURITY DEFINER) — bypass RLS.
ALTER TABLE admin_actions DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON admin_actions;

CREATE POLICY admin_actions_owner ON admin_actions
  FOR SELECT
  TO anon, authenticated
  USING (admin_phone = public.auth_user_phone());
