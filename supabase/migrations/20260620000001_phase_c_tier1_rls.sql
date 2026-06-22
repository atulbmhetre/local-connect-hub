-- ============================================================
-- PHASE C TIER 1 — Financial tables RLS
-- Replaces open anon_all policies with phone-ownership checks
-- auth.users.phone stores '91XXXXXXXXXX' (no + prefix)
-- our tables store user_phone as 10-digit '9XXXXXXXXX'
-- bridge: strip leading '91' from auth.users.phone to match
-- ============================================================

-- Helper function: get current user's 10-digit phone from session
CREATE OR REPLACE FUNCTION public.auth_user_phone()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN LENGTH(phone) = 12 AND phone LIKE '91%'
    THEN SUBSTRING(phone FROM 3)
    ELSE phone
  END
  FROM auth.users
  WHERE id = auth.uid()
$$;

-- ── order_bills ──────────────────────────────────────────────
ALTER TABLE order_bills DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_bills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON order_bills;

-- Vendor can see/manage their own bills
CREATE POLICY order_bills_vendor ON order_bills
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

-- Customer can see their own bills directly via user_phone
CREATE POLICY order_bills_customer ON order_bills
  FOR SELECT
  TO anon, authenticated
  USING (
    user_phone = public.auth_user_phone()
  );

-- ── order_items ──────────────────────────────────────────────
ALTER TABLE order_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON order_items;

-- Vendor can see/manage items for their own orders
CREATE POLICY order_items_vendor ON order_items
  FOR ALL
  TO anon, authenticated
  USING (
    request_id IN (
      SELECT r.id FROM requests r
      JOIN vendors v ON v.id = r.vendor_id
      WHERE v.phone = public.auth_user_phone()
    )
  )
  WITH CHECK (
    request_id IN (
      SELECT r.id FROM requests r
      JOIN vendors v ON v.id = r.vendor_id
      WHERE v.phone = public.auth_user_phone()
    )
  );

-- Customer can see items for their own orders
CREATE POLICY order_items_customer ON order_items
  FOR SELECT
  TO anon, authenticated
  USING (
    request_id IN (
      SELECT id FROM requests 
      WHERE user_phone = public.auth_user_phone()
    )
  );

-- ── khata_ledger ─────────────────────────────────────────────
ALTER TABLE khata_ledger DISABLE ROW LEVEL SECURITY;
ALTER TABLE khata_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON khata_ledger;

CREATE POLICY khata_ledger_vendor ON khata_ledger
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

CREATE POLICY khata_ledger_customer ON khata_ledger
  FOR SELECT
  TO anon, authenticated
  USING (
    user_phone = public.auth_user_phone()
  );

-- ── khata_transactions ───────────────────────────────────────
ALTER TABLE khata_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE khata_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_all ON khata_transactions;

CREATE POLICY khata_transactions_vendor ON khata_transactions
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

CREATE POLICY khata_transactions_customer ON khata_transactions
  FOR SELECT
  TO anon, authenticated
  USING (
    user_phone = public.auth_user_phone()
  );

-- ── vendor_credits ───────────────────────────────────────────
ALTER TABLE vendor_credits DISABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_credits_insert ON vendor_credits;
DROP POLICY IF EXISTS vendor_credits_select ON vendor_credits;

CREATE POLICY vendor_credits_vendor ON vendor_credits
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

-- process-vendor-referral edge function uses service role — bypasses RLS.
-- No special policy needed for referral credit inserts.
