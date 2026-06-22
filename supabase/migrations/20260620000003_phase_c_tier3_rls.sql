-- ============================================================
-- PHASE C TIER 3 — Content/config tables RLS
-- Uses public.auth_user_phone() from Tier 1 migration
-- ============================================================

-- ── app_config ───────────────────────────────────────────────
-- Public READ — app reads config before user logs in.
-- Admin writes via service role RPC only.
ALTER TABLE app_config DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON app_config;

CREATE POLICY app_config_public_read ON app_config
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ── categories ───────────────────────────────────────────────
-- Public READ — Radar reads categories before login.
-- Admin writes via service role RPC only.
ALTER TABLE categories DISABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON categories;

CREATE POLICY categories_public_read ON categories
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ── category_translations ────────────────────────────────────
-- Public READ — same as categories.
ALTER TABLE category_translations DISABLE ROW LEVEL SECURITY;
ALTER TABLE category_translations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON category_translations;

CREATE POLICY category_translations_public_read ON category_translations
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ── feed_posts ───────────────────────────────────────────────
-- Public READ of non-hidden posts (feed is public).
-- INSERT by authenticated user (vendor or customer).
-- UPDATE/DELETE by owner only.
ALTER TABLE feed_posts DISABLE ROW LEVEL SECURITY;
ALTER TABLE feed_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON feed_posts;

CREATE POLICY feed_posts_public_read ON feed_posts
  FOR SELECT
  TO anon, authenticated
  USING (is_hidden = false);

CREATE POLICY feed_posts_owner_insert ON feed_posts
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (user_phone = public.auth_user_phone());

CREATE POLICY feed_posts_owner_modify ON feed_posts
  FOR UPDATE
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

CREATE POLICY feed_posts_owner_delete ON feed_posts
  FOR DELETE
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone());

-- ── feed_replies ─────────────────────────────────────────────
-- Public READ — replies visible to all.
-- INSERT/DELETE by owner only.
ALTER TABLE feed_replies DISABLE ROW LEVEL SECURITY;
ALTER TABLE feed_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON feed_replies;

CREATE POLICY feed_replies_public_read ON feed_replies
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY feed_replies_owner_insert ON feed_replies
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (user_phone = public.auth_user_phone());

CREATE POLICY feed_replies_owner_delete ON feed_replies
  FOR DELETE
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone());

-- ── feed_flags ───────────────────────────────────────────────
-- INSERT by authenticated user flagging content.
-- SELECT by owner only (see own flags).
-- Admin reads all via service role.
ALTER TABLE feed_flags DISABLE ROW LEVEL SECURITY;
ALTER TABLE feed_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON feed_flags;

CREATE POLICY feed_flags_owner ON feed_flags
  FOR ALL
  TO anon, authenticated
  USING (flagged_by_phone = public.auth_user_phone())
  WITH CHECK (flagged_by_phone = public.auth_user_phone());

-- ── requests ─────────────────────────────────────────────────
-- Customer sees/inserts own requests (user_phone match).
-- Vendor sees own requests (vendor_id match).
-- Status updates allowed by both parties (accept/complete/cancel).
-- Drop ALL existing messy policies and replace cleanly.
ALTER TABLE requests DISABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON requests;
DROP POLICY IF EXISTS requests_insert ON requests;
DROP POLICY IF EXISTS requests_select ON requests;
DROP POLICY IF EXISTS "Anyone can update request status" ON requests;
DROP POLICY IF EXISTS "User can edit own order message" ON requests;
DROP POLICY IF EXISTS "Vendor can cancel own orders" ON requests;

-- Customer manages own requests
CREATE POLICY requests_customer ON requests
  FOR ALL
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

-- Vendor sees and updates requests assigned to them
CREATE POLICY requests_vendor ON requests
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

-- ── saved_vendors ────────────────────────────────────────────
-- User manages own saved vendors (user_phone match).
ALTER TABLE saved_vendors DISABLE ROW LEVEL SECURITY;
ALTER TABLE saved_vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON saved_vendors;
DROP POLICY IF EXISTS saved_vendors_delete ON saved_vendors;
DROP POLICY IF EXISTS saved_vendors_insert ON saved_vendors;
DROP POLICY IF EXISTS saved_vendors_select ON saved_vendors;

CREATE POLICY saved_vendors_owner ON saved_vendors
  FOR ALL
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

-- ── user_addresses ───────────────────────────────────────────
-- User manages own addresses.
ALTER TABLE user_addresses DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON user_addresses;

CREATE POLICY user_addresses_owner ON user_addresses
  FOR ALL
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

-- ── user_flags ───────────────────────────────────────────────
-- User inserts own flags (reporting bad vendor/order).
-- Admin reads/updates via service role.
ALTER TABLE user_flags DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON user_flags;

CREATE POLICY user_flags_owner ON user_flags
  FOR ALL
  TO anon, authenticated
  USING (user_phone = public.auth_user_phone())
  WITH CHECK (user_phone = public.auth_user_phone());

-- ── vendor_menu_items ────────────────────────────────────────
-- Public READ — customers browse menu before ordering.
-- Vendor manages own menu items.
ALTER TABLE vendor_menu_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_menu_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON vendor_menu_items;

CREATE POLICY vendor_menu_items_public_read ON vendor_menu_items
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY vendor_menu_items_owner ON vendor_menu_items
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
