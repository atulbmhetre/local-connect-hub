-- PROD ONLY: drop legacy permissive RLS policies that survived Phase C migrations
-- because they were named differently from anon_all (dashboard-era names).
--
-- STATUS: DRAFT — DO NOT APPLY until explicitly confirmed.
-- Target: rpxsyeqskvhjmbkxnpmd (PROD)
-- Audit source: prod_all_true_policies.json (2026-07-05, 39 true-expression policies)
--
-- Keeps Phase C intentional public SELECT policies:
--   app_config_public_read, categories_public_read, category_translations_public_read,
--   feed_replies_public_read, vendor_menu_items_public_read, vendor_reviews_public_read,
--   vendors_public_read, feed_posts_public_read (is_hidden = false, not in this migration)

-- ── app_config: legacy duplicate ─────────────────────────────────────────────
DROP POLICY IF EXISTS "app_config read only" ON public.app_config;

-- ── categories: legacy duplicates + misnamed open ALL ───────────────────────
DROP POLICY IF EXISTS "Public read categories" ON public.categories;
DROP POLICY IF EXISTS "Service role can upsert categories" ON public.categories;

-- ── category_translations: legacy duplicate ─────────────────────────────────
DROP POLICY IF EXISTS "Public read" ON public.category_translations;

-- ── feed: legacy open write/read policies (Phase C uses auth_user_phone) ───
DROP POLICY IF EXISTS feed_flags_insert ON public.feed_flags;
DROP POLICY IF EXISTS feed_posts_insert ON public.feed_posts;
DROP POLICY IF EXISTS feed_posts_update ON public.feed_posts;
DROP POLICY IF EXISTS feed_replies_insert ON public.feed_replies;
DROP POLICY IF EXISTS feed_replies_read ON public.feed_replies;

-- ── financial (Tier 1) ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS khata_ledger_all ON public.khata_ledger;
DROP POLICY IF EXISTS "Allow all on khata_transactions" ON public.khata_transactions;
DROP POLICY IF EXISTS "Allow select khata_transactions" ON public.khata_transactions;
DROP POLICY IF EXISTS order_bills_all ON public.order_bills;
DROP POLICY IF EXISTS order_items_all ON public.order_items;

-- ── requests (Tier 3) ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow public inserts from mobile app" ON public.requests;
DROP POLICY IF EXISTS "Anyone can insert requests" ON public.requests;
DROP POLICY IF EXISTS "Anyone can read requests" ON public.requests;

-- ── saved_vendors (Tier 3) ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can manage their saved vendors" ON public.saved_vendors;

-- ── user_addresses (Tier 3) ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can delete own addresses" ON public.user_addresses;
DROP POLICY IF EXISTS "Users can insert own addresses" ON public.user_addresses;
DROP POLICY IF EXISTS "Users can update own addresses" ON public.user_addresses;

-- ── user_devices (Tier 2) ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow insert user devices" ON public.user_devices;
DROP POLICY IF EXISTS "Allow select user devices" ON public.user_devices;
DROP POLICY IF EXISTS "Allow update user devices" ON public.user_devices;

-- ── user_flags (Tier 3) ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can insert flags" ON public.user_flags;
DROP POLICY IF EXISTS "Anyone can read flags" ON public.user_flags;
DROP POLICY IF EXISTS "Anyone can update flags" ON public.user_flags;

-- ── users (Tier 2) ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can insert users" ON public.users;
DROP POLICY IF EXISTS "Anyone can read users" ON public.users;
DROP POLICY IF EXISTS "Anyone can update users" ON public.users;

-- ── vendor_menu_items: legacy open ALL (keep vendor_menu_items_public_read) ─
DROP POLICY IF EXISTS menu_items_all ON public.vendor_menu_items;

-- ── vendor_reviews: legacy open ALL (keep vendor_reviews_public_read) ───────
DROP POLICY IF EXISTS vendor_reviews_all ON public.vendor_reviews;
