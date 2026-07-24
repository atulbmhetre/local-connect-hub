# Backend Inventory

**Method:** All 149 SQL files under `supabase/migrations/` read in chronological order (final `CREATE OR REPLACE` definition wins). Client call sites from `grep .rpc(` in `src/` only.

**Stats:**
- Migration files read: **149**
- RPC/functions catalogued: **107**
- Tables referenced in final policy/index/function map: **31**
- RLS policies catalogued: **43**
- Indexes catalogued: **31**

---

## RPC / Function Catalog

### `_admin_guard_bypassed()`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** sql; **SECURITY DEFINER:** no
- **What it does:** SELECT current_setting('app.via_admin_rpc', true) = 'true'
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** See SQL body in latest migration file.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `_anonymise_customer_phone(p_original_phone text, p_anon_tag text)`

- **Latest migration:** `20260614000004_account_deletion_fixes.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests UPDATE public.vendor_reviews UPDATE public.feed_posts UPDATE public.feed_posts UPDATE public.feed_replies UPDATE public.feed_flags UPDATE public.user_flags UPDATE public.order_bills
- **Tables read:** app_users, saved_vendors, user_addresses, user_devices, user_notifications
- **Tables written:** app_users, feed_flags, feed_posts, feed_replies, khata_ledger, khata_transactions, order_bills, referrals, requests, saved_vendors, user_addresses, user_devices, user_flags, user_notifications, users, vendor_reviews
- **Identity verification:** WHERE samples: `WHERE user_phone = p_original_phone` | `WHERE user_phone = p_original_phone`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Multi-write (app_users, feed_flags, feed_posts, feed_replies, khata_ledger, khata_transactions, order_bills, referrals, requests, saved_vendors, user_addresses, user_devices, user_flags, user_notifications, users, vendor_reviews) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `_customer_identity_ok(p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** sql; **SECURITY DEFINER:** no
- **What it does:** SELECT p_device_id IS NOT NULL OR p_user_phone IS NOT NULL;
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `_customer_owns_request(p_request_id uuid, p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** sql; **SECURITY DEFINER:** no
- **What it does:** SELECT EXISTS ( SELECT 1
- **Tables read:** requests
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE r.id = p_request_id
      AND (
        (p_user_phone IS NOT NULL AND r.user_phone = p_user_phone)
        OR (p_device_id IS NOT NULL AND r.device_id = p_device_id)
      )
  )`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `_vendor_owns_request(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** sql; **SECURITY DEFINER:** no
- **What it does:** SELECT EXISTS ( SELECT 1
- **Tables read:** requests, vendors
- **Tables written:** —
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id
      AND r.vendor_id = p_vendor_id
      AND v.phone = p_vendor_phone
  )`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)

### `add_bill_to_khata(p_bill_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260702000012_add_bill_to_khata.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT EXISTS ( SELECT 1 RAISE EXCEPTION 'unauthorised'; SELECT IF NOT FOUND THEN RAISE EXCEPTION 'bill_not_found'; IF v_bill.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'bill_not_unpaid';
- **Tables read:** order_bills, vendors
- **Tables written:** khata_ledger, khata_transactions, order_bills
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised'` | `WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (khata_ledger, khata_transactions, order_bills) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `admin_apply_vendor_waiveoff(p_admin_phone text, p_vendor_id uuid, p_percent integer, p_months integer)`

- **Latest migration:** `20260701000001_fix_full_schema_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; IF p_percent IS NULL OR p_percent <= 0 OR p_percent > 100 THEN RAISE EXCEPTION 'invalid_percent'; IF p_months IS NULL OR p_months <= 0 OR p_months > 12 THEN RAISE EXCEPTION 'invalid_months'; UPDATE public.vendors v IF NOT FOUND THEN
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE v.id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/pages/Settings.tsx

### `admin_approve_category(p_admin_phone text, p_category_id uuid)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.categories IF NOT FOUND THEN RAISE EXCEPTION 'category not found';
- **Tables read:** —
- **Tables written:** categories
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE id = p_category_id`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: categories.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_ban_user(p_admin_phone text, p_user_phone text, p_reason text)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.users IF NOT FOUND THEN RAISE EXCEPTION 'user not found';
- **Tables read:** —
- **Tables written:** users
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE phone = trim(p_user_phone)`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: users.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_ban_vendor(p_admin_phone text, p_vendor_id uuid, p_reason text)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.vendors IF NOT FOUND THEN RAISE EXCEPTION 'vendor not found';
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_delete_review(p_admin_phone text, p_review_id uuid)`

- **Latest migration:** `20260708000002_admin_session_auth.sql` (auth gate; rating recalc from `20260626000001`)
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_session() THEN RAISE EXCEPTION 'unauthorized'; SELECT vendor_id INTO v_vendor_id; IF v_vendor_id IS NULL THEN RAISE EXCEPTION 'review not found'; PERFORM set_config('app.via_admin_rpc', 'true', true); DELETE FROM public.vendor_reviews WHERE id = p_review_id; recalculate vendors.avg_rating / review_count
- **Tables read:** vendor_reviews
- **Tables written:** vendor_reviews, vendors
- **Identity verification:** Admin JWT session via `is_admin_session()` (not phone). `p_admin_phone` is retained for call-site compatibility / audit labeling only. WHERE samples: `WHERE id = p_review_id`
- **Grants:** REVOKE ALL FROM PUBLIC / anon; GRANT EXECUTE TO authenticated (`20260708000002`)
- **Transactional integrity:** Multi-write (vendor_reviews, vendors) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** —

### `admin_get_user_lang(p_admin_phone text, p_user_phone text)`

- **Latest migration:** `20260630000001_fix_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; SELECT au.lang RETURN COALESCE(NULLIF(TRIM(v_lang), ''), 'en');
- **Tables read:** app_users
- **Tables written:** —
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE au.phone = NULLIF(TRIM(p_user_phone), '')`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/lib/warnFlaggedUser.ts

### `admin_reject_category(p_admin_phone text, p_category_id uuid)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.categories IF NOT FOUND THEN RAISE EXCEPTION 'category not found';
- **Tables read:** —
- **Tables written:** categories
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE id = p_category_id`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: categories.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_set_vendor_check(p_admin_phone text, p_vendor_id uuid, p_status text)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; IF p_status NOT IN ('passed', 'failed') THEN RAISE EXCEPTION 'invalid status'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.vendor_verification INSERT INTO public.vendor_verification (
- **Tables read:** —
- **Tables written:** vendor_verification
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE vendor_id = p_vendor_id
    AND check_type = 'admin_check'
    AND is_latest = true`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: vendor_verification.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_unban_user(p_admin_phone text, p_user_phone text)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.users IF NOT FOUND THEN RAISE EXCEPTION 'user not found';
- **Tables read:** —
- **Tables written:** users
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE phone = trim(p_user_phone)`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: users.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_unban_vendor(p_admin_phone text, p_vendor_id uuid)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.vendors IF NOT FOUND THEN RAISE EXCEPTION 'vendor not found';
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_unverify_vendor(p_admin_phone text, p_vendor_id uuid)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.vendors IF NOT FOUND THEN RAISE EXCEPTION 'vendor not found';
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_update_app_config(p_admin_phone text, p_key text, p_value text)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; IF NULLIF(trim(p_key), '') IS NULL THEN RAISE EXCEPTION 'invalid key'; PERFORM set_config('app.via_admin_rpc', 'true', true); INSERT INTO public.app_config (key, value)
- **Tables read:** —
- **Tables written:** app_config
- **Identity verification:** Admin phone guard.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: app_config.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_verify_vendor(p_admin_phone text, p_vendor_id uuid)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.vendors IF NOT FOUND THEN RAISE EXCEPTION 'vendor not found';
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `admin_warn_user(p_admin_phone text, p_user_phone text)`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.is_admin_phone(p_admin_phone) THEN RAISE EXCEPTION 'unauthorized'; PERFORM set_config('app.via_admin_rpc', 'true', true); UPDATE public.users RETURNING warn_count INTO v_next_warn_count; IF v_next_warn_count IS NULL THEN RAISE EXCEPTION 'user not found'; RETURN v_next_warn_count;
- **Tables read:** —
- **Tables written:** users
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE phone = trim(p_user_phone)
  RETURNING warn_count INTO v_next_warn_count`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: users.
- **Called from src/:** src/lib/warnFlaggedUser.ts
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `anonymise_deleted_accounts()`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT u.phone PERFORM public._anonymise_customer_phone(original_phone, anon_tag); UPDATE public.users SELECT v.phone PERFORM set_config('app.via_system_rpc', 'true', true); UPDATE public.vendors
- **Tables read:** user_devices, users, vendor_categories, vendor_credits, vendor_menu_items, vendor_verification, vendors
- **Tables written:** categories, user_devices, users, vendor_categories, vendor_credits, vendor_menu_items, vendor_verification, vendors
- **Identity verification:** WHERE samples: `WHERE u.deletion_requested_at IS NOT NULL
      AND NOT starts_with(u.phone, 'deleted_')
  LOOP
    original_phone := rec.phone` | `WHERE phone = anon_tag`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Multi-write (categories, user_devices, users, vendor_categories, vendor_credits, vendor_menu_items, vendor_verification, vendors) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `attach_pending_category(p_vendor_id uuid, p_category_id uuid, p_service_mode text)`

- **Latest migration:** `20260614100001_attach_pending_category_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** DELETE FROM public.vendor_categories INSERT INTO public.vendor_categories (
- **Tables read:** vendor_categories
- **Tables written:** vendor_categories
- **Identity verification:** WHERE samples: `WHERE vendor_id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_categories. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/lib/supabase.ts

### `audit_anon_open_rls_policies()`

- **Latest migration:** `20260705000003_audit_anon_open_rls_policies_rpc.sql`
- **Language:** sql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT SELECT jsonb_agg(rolname ORDER BY rolname) SELECT 1
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** WHERE samples: `WHERE r.oid = ANY (p.polroles)
        ),
        '[]'::jsonb
      ) AS roles,
      (p.polroles = '{}'::oid[]) AS is_public_role,
      pg_get_expr(p.polqual, p.polrelid) AS using_exp` | `WHERE n.nspname = 'public'
      AND p.polpermissive = true
      AND (
        p.polroles = '{}'::oid[]
        OR EXISTS (
          SELECT 1
          FROM pg_roles r
          WHERE`
- **Grants:** **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)

### `auth_user_phone()`

- **Latest migration:** `20260708000001_phone_format_and_auth_user_phone.sql`
- **Language:** sql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT CASE
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** References `auth.uid()`. WHERE samples: `WHERE id = auth.uid()`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `cancel_customer_order(p_request_id uuid, p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_device_id IS NULL AND p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.requests IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE id = p_request_id
    AND status IN ('sent', 'seen')
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_d`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/pages/MyOrders.tsx

### `check_and_log_rate_limit(p_function_name text, p_identifier_type text, p_identifier text, p_max_requests int, p_window_seconds int)`

- **Latest migration:** `20260705000006_edge_function_rate_limiting.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** select count(*) into v_count if v_count >= p_max_requests then return false; -- blocked insert into public.edge_function_rate_limits (function_name, identifier_type, identifier) return true; -- allowed
- **Tables read:** edge_function_rate_limits
- **Tables written:** edge_function_rate_limits
- **Identity verification:** WHERE samples: `where function_name = p_function_name
    and identifier_type = p_identifier_type
    and identifier = p_identifier
    and created_at > now() - make_interval(secs => p_window_seconds)`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: edge_function_rate_limits. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** No src/ RPC call site; Missing REVOKE ALL FROM PUBLIC

### `check_bill_before_fulfil()`

- **Latest migration:** `20260630000002_check_bill_before_fulfil_by_mode.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NEW.status = 'fulfilled' AND OLD.status IS DISTINCT FROM 'fulfilled' THEN SELECT v.service_mode IF v_service_mode IN ('delivery', 'appointment') THEN IF NOT EXISTS ( SELECT 1 FROM public.order_bills WHERE request_id = NEW.id RAISE EXCEPTION 'cannot_fulfil_without_bill'; RETURN NEW;
- **Tables read:** order_bills, vendors
- **Tables written:** —
- **Identity verification:** WHERE samples: `WHERE v.id = NEW.vendor_id` | `WHERE request_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'cannot_fulfil_without_bill'`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `claim_customer_payment(p_request_id uuid, p_payment_utr text, p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_device_id IS NULL AND p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.requests IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE id = p_request_id
    AND status = 'fulfilled'
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_device_`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/components/ParchiSheet.tsx, src/components/PaymentSheet.tsx

### `clear_user_notifications(p_user_phone text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; DELETE FROM public.user_notifications
- **Tables read:** user_notifications
- **Tables written:** user_notifications
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE user_phone = p_user_phone`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: user_notifications. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/NotificationBell.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `confirm_upi_payment(p_request_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000010_fix_upi_payment_rpcs.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT EXISTS ( SELECT 1 FROM public.requests r RAISE EXCEPTION 'unauthorised'; IF NOT EXISTS ( SELECT 1 FROM public.requests RAISE EXCEPTION 'payment_not_claimed'; UPDATE public.requests UPDATE public.order_bills
- **Tables read:** requests, vendors
- **Tables written:** order_bills, requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised'` | `WHERE id = p_request_id AND payment_status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'payment_not_claimed'`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (order_bills, requests) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `create_customer_request(p_device_id text, p_vendor_id uuid, p_message text, p_user_phone text, p_device_id_log text, p_delivery_address text, p_delivery_slot text, p_delivery_slot_deadline timestamptz, p_appointment_time timestamptz, p_appointment_status text, p_customer_latitude double, p_customer_longitude double)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN RAISE EXCEPTION 'identity_required'; INSERT INTO public.requests ( RETURNING id INTO v_id; RETURN v_id;
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** Calls customer ownership helper. **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/components/ParchiSheet.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `create_referred_user(p_phone text, p_device_id text, p_referral_code text, p_referred_by_vendor_id uuid)`

- **Latest migration:** `20260630000001_fix_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RETURN false; IF EXISTS (SELECT 1 FROM public.app_users au WHERE au.phone = v_phone) THEN RETURN false; SELECT v.phone IF NOT FOUND THEN RETURN false; IF right(regexp_replace(COALESCE(v_vendor_phone, ''), '\D', '', 'g'), 10)
- **Tables read:** app_users, vendors
- **Tables written:** app_users
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE au.phone = v_phone) THEN
    RETURN false` | `WHERE v.id = p_referred_by_vendor_id
    AND upper(trim(v.referral_code)) = upper(trim(p_referral_code))`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: app_users. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/lib/referral.ts

### `delete_user_address(p_user_phone text, p_address_id uuid)`

- **Latest migration:** `20260701000005_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; DELETE FROM public.user_addresses IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** user_addresses
- **Tables written:** user_addresses
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE id = p_address_id
    AND user_phone = v_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_addresses. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/Settings.tsx

### `delete_user_devices_for_phone(p_user_phone text)`

- **Latest migration:** `20260701000002_drop_duplicate_function_overloads.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN RAISE EXCEPTION 'identity_required'; DELETE FROM public.user_devices ud
- **Tables read:** user_devices
- **Tables written:** user_devices
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE ud.user_phone = trim(p_user_phone)`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_devices. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/Settings.tsx

### `delete_user_notification(p_user_phone text, p_notification_id uuid)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; DELETE FROM public.user_notifications IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** user_notifications
- **Tables written:** user_notifications
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE id = p_notification_id
    AND user_phone = p_user_phone`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: user_notifications. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/NotificationBell.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `dismiss_order(p_request_id uuid, p_device_id text, p_user_phone text, p_appointment_status text)`

- **Latest migration:** `20260628000006_dismiss_order_appointment.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_device_id IS NULL AND p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.requests IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE id = p_request_id
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR
      (p_device_id IS NOT NULL AND device_id = p_device_id)
    )`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/pages/MyOrders.tsx

### `dispute_upi_payment(p_request_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000010_fix_upi_payment_rpcs.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT EXISTS ( SELECT 1 FROM public.requests r RAISE EXCEPTION 'unauthorised'; IF NOT EXISTS ( SELECT 1 FROM public.requests RAISE EXCEPTION 'payment_not_claimed'; UPDATE public.requests
- **Tables read:** requests, vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised'` | `WHERE id = p_request_id AND payment_status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'payment_not_claimed'`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `edit_customer_order(p_request_id uuid, p_message text, p_previous_message text, p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_device_id IS NULL AND p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.requests IF NOT FOUND THEN RAISE EXCEPTION 'not_editable_or_unauthorized';
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE id = p_request_id
    AND status IN ('sent', 'seen')
    AND (
      (p_user_phone IS NOT NULL AND user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND device_id = p_d`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/pages/MyOrders.tsx

### `expire_pending_orders()`

- **Latest migration:** `20260611020001_expire_order_fcm_notify_prod.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** PERFORM public.warn_pending_orders_near_deadline(); SELECT NULLIF(trim(value), '')::integer SELECT NULLIF(trim(value), '')::integer IF help_accept_timeout_minutes IS NULL THEN RAISE EXCEPTION 'app_config key help_accept_timeout_mi
- **Tables read:** app_config, vendors
- **Tables written:** requests, user_notifications
- **Identity verification:** WHERE samples: `WHERE key = 'help_accept_timeout_minutes'` | `WHERE key = 'appointment_accept_timeout_hours'`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Multi-write (requests, user_notifications) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `get_admin_dashboard_stats(p_admin_phone text)`

- **Latest migration:** `20260702000007_fix_vendors_created_at_admin_stats.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF NOT public.is_admin_phone(v_phone) THEN RAISE EXCEPTION 'unauthorized'; SELECT count(*)::integer INTO v_total_orders FROM public.requests; SELECT count(*)::integer INTO v_orders_today SELECT count(*)::integer INTO v_orders_this_week
- **Tables read:** app_users, referrals, requests, users, vendors
- **Tables written:** —
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE created_at >= v_start_of_today` | `WHERE created_at`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `get_feed_preferences(p_user_phone text)`

- **Latest migration:** `20260702000003_feed_reader_radius_preference.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; SELECT au.feed_discovery_radius_km RETURN jsonb_build_object(
- **Tables read:** app_users
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE au.phone = v_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/pages/Settings.tsx, src/pages/LocalFeed.tsx

### `get_local_feed_posts(p_reader_lat double, p_reader_lng double, p_limit integer, p_reader_radius_km integer)`

- **Latest migration:** `20260702000003_feed_reader_radius_preference.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_reader_lat IS NULL OR p_reader_lng IS NULL THEN RAISE EXCEPTION 'reader_location_required'; RETURN COALESCE( SELECT jsonb_agg(row_data ORDER BY created_at DESC) SELECT
- **Tables read:** feed_posts, vendors
- **Tables written:** —
- **Identity verification:** See SQL body in latest migration file.
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/pages/LocalFeed.tsx

### `get_recommendations_for_admin(p_admin_phone text)`

- **Latest migration:** `20260702000004_get_recommendations_for_admin.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF NOT v_super_admin THEN SELECT v.id IF v_vendor_id IS NULL THEN RAISE EXCEPTION 'unauthorized'; RETURN COALESCE( SELECT jsonb_agg(row_data ORDER BY created_at DESC)
- **Tables read:** feed_posts, vendors
- **Tables written:** —
- **Identity verification:** Admin phone guard. WHERE samples: `WHERE v.phone = v_phone
      AND v.is_active = true
    ORDER BY v.last_updated DESC NULLS LAST
    LIMIT 1`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/pages/Settings.tsx

### `get_user_device(p_user_phone text, p_device_id text)`

- **Latest migration:** `20260701000004_user_devices_select_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF p_device_id IS NULL OR trim(p_device_id) = '' THEN RAISE EXCEPTION 'device_id_required'; SELECT ud.* RETURN v_row;
- **Tables read:** user_devices
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id)`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/hooks/useFeedNotificationsEnabled.ts, src/pages/LocalFeed.tsx

### `get_user_device_feed_notifications(p_user_phone text, p_device_id text)`

- **Latest migration:** `20260701000002_drop_duplicate_function_overloads.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF p_device_id IS NULL OR trim(p_device_id) = '' THEN RAISE EXCEPTION 'device_id_required'; SELECT ud.feed_notifications_enabled RETURN COALESCE(v_enabled, true);
- **Tables read:** user_devices
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id)`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** No src/ RPC call site

### `get_user_notifications(p_user_phone text, p_device_id text, p_limit integer)`

- **Latest migration:** `20260702000010_get_user_notifications_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL AND NULLIF(trim(COALESCE(p_device_id, '')), '') IS NOT NULL THEN SELECT u.phone IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; RETURN COALESCE( SELECT jsonb_agg(row_data ORDER BY is_read ASC, created_at DESC) SELECT
- **Tables read:** user_notifications, users
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE u.device_id = p_device_id
    ORDER BY u.last_active DESC NULLS LAST
    LIMIT 1` | `WHERE`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/components/NotificationBell.tsx

### `get_vendor_customer_names(p_vendor_phone text)`

- **Latest migration:** `20260628000011_vendor_customer_names_rpc.sql`
- **Language:** sql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT
- **Tables read:** app_users, khata_ledger, vendors
- **Tables written:** —
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.phone = p_vendor_phone
    AND kl.user_phone IS NOT NULL`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/pages/LedgerView.tsx

### `increment_vendor_delivered(p_vendor_id uuid)`

- **Latest migration:** `20260509120000_vendor_resolution_rpcs.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendors
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/components/RadarVendorCard.tsx, src/components/RatingSheet.tsx

### `increment_vendor_helped(p_vendor_id uuid)`

- **Latest migration:** `20260509120000_vendor_resolution_rpcs.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendors
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/components/RadarVendorCard.tsx, src/components/RatingSheet.tsx

### `increment_vendor_issues(p_vendor_id uuid)`

- **Latest migration:** `20260614000005_vendor_issues_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendors
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** WHERE samples: `WHERE id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/components/RatingSheet.tsx

### `insert_bill_with_items(p_order_id uuid, p_vendor_id uuid, p_customer_phone text, p_total numeric, p_payment_mode text, p_payment_status text, p_notes text, p_items jsonb)`

- **Latest migration:** `20260703000002_order_items_total_price_generated.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT IF FOUND THEN IF v_void_bill.payment_mode = 'khata' AND v_void_bill.user_phone IS NOT NULL THEN INSERT INTO public.khata_transactions ( SELECT kl.total_outstanding
- **Tables read:** khata_ledger, order_bills
- **Tables written:** khata_ledger, khata_transactions, order_bills, order_items
- **Identity verification:** WHERE samples: `WHERE ob.request_id = p_order_id
    AND ob.payment_status = 'void'
  LIMIT 1` | `WHERE kl.ven`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (khata_ledger, khata_transactions, order_bills, order_items) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/BillSheet.tsx, src/components/IncomingOrdersSection.tsx

### `insert_user_address(p_device_id text, p_user_phone text, p_label text, p_address_text text, p_is_default boolean)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN RAISE EXCEPTION 'identity_required'; INSERT INTO public.user_addresses (device_id, user_phone, label, address_text, is_default)
- **Tables read:** —
- **Tables written:** user_addresses
- **Identity verification:** Calls customer ownership helper. **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: user_addresses.
- **Called from src/:** src/components/ParchiSheet.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `is_admin_phone(p_phone text)`

- **Latest migration:** `20260618000006_admin_server_side_auth.sql`
- **Language:** sql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT NULLIF(trim(p_phone), '') IS NOT NULL
- **Tables read:** app_config
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE key = 'admin_phone')), '')`
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** No src/ RPC call site

### `log_admin_action(p_admin_phone text, p_action_type text, p_target_type text, p_target_id text, p_notes text)`

- **Latest migration:** `20260701000005_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF NOT public.is_admin_phone(v_phone) THEN RAISE EXCEPTION 'unauthorized'; INSERT INTO public.admin_actions (
- **Tables read:** —
- **Tables written:** admin_actions
- **Identity verification:** Admin phone guard.
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: admin_actions.
- **Called from src/:** src/lib/adminAudit.ts

### `lookup_user_by_phone(p_phone text)`

- **Latest migration:** `20260625000001_public_user_lookup_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** RETURN QUERY SELECT u.total_orders, u.completed_orders, u.trust_score, u.warn_count, u.is_banned
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE u.phone = p_phone
  LIMIT 1`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** src/components/FirstOpenFlow.tsx, src/components/PhoneEntrySheet.tsx, src/pages/Settings.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `mark_user_notification_read(p_user_phone text, p_notification_id uuid)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.user_notifications IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** —
- **Tables written:** user_notifications
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE id = p_notification_id
    AND user_phone = p_user_phone`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: user_notifications.
- **Called from src/:** src/components/NotificationBell.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `mark_user_notifications_read(p_user_phone text, p_informational_only boolean)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.user_notifications
- **Tables read:** —
- **Tables written:** user_notifications
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE user_phone = p_user_phone
    AND is_read = false
    AND (NOT p_informational_only OR is_informational = true)`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: user_notifications.
- **Called from src/:** src/components/NotificationBell.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `migrate_device_requests_phone(p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_device_id IS NULL OR p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.requests
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE device_id = p_device_id
    AND (user_phone IS NULL OR user_phone <> p_user_phone)`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/lib/userIdentity.ts

### `migrate_saved_vendors_phone(p_device_id text, p_user_phone text)`

- **Latest migration:** `20260704000001_migrate_saved_vendors_phone_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_device_id IS NULL OR p_user_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; UPDATE public.saved_vendors
- **Tables read:** —
- **Tables written:** saved_vendors
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE device_id = p_device_id
    AND (user_phone IS NULL OR user_phone <> p_user_phone)`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: saved_vendors.
- **Called from src/:** src/lib/userIdentity.ts

### `notify_order_bill_trigger()`

- **Latest migration:** `20260626000009_fix_bill_notify_trigger_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NEW.user_phone IS NULL OR trim(NEW.user_phone) = '' THEN RETURN NEW; IF NEW.payment_status = 'void' THEN RETURN NEW; SELECT v.shop_name INSERT INTO public.user_notifications ( SELECT value INTO notify_url FROM public.app_config WHERE key = 'edge_function_url'; SELECT value INTO notify_key FROM public.app_config WHERE key = 'anon_key';
- **Tables read:** app_config, vendors
- **Tables written:** user_notifications
- **Identity verification:** WHERE samples: `WHERE v.id = NEW.vendor_id` | `WHERE key = 'edge_function_url'`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: user_notifications. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `prevent_direct_admin_column_writes()`

- **Latest migration:** `20260618000007_tighten_admin_rls.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** no
- **What it does:** IF public._admin_guard_bypassed() THEN RETURN COALESCE(NEW, OLD); IF TG_TABLE_NAME = 'vendors' AND TG_OP = 'UPDATE' THEN IF NEW.is_banned IS DISTINCT FROM OLD.is_banned RAISE EXCEPTION 'direct admin column write blocked on vendors'; IF NEW.is_banned IS DISTINCT FROM OLD.is_banned RAISE EXCEPTION 'direct admin column write blocked on users'; IF NEW.is_active IS DISTINCT FROM OLD.is_active
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** Admin phone guard.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `recalculate_vendor_on_time_rate(p_vendor_id uuid)`

- **Latest migration:** `20260614000006_delivery_on_time_rate.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT count(*) INTO v_total IF v_total = 0 THEN RETURN; SELECT count(*) INTO v_on_time UPDATE public.vendors
- **Tables read:** requests
- **Tables written:** vendors
- **Identity verification:** WHERE samples: `WHERE vendor_id = p_vendor_id
    AND status = 'fulfilled'
    AND delivery_slot_deadline IS NOT NULL
    AND fulfilled_at IS NOT NULL` | `WHERE vendor_id = p_vendor_id
    AND status = 'fulfilled'
    AND delivery_slot_deadline IS NOT NULL
    AND fulfilled_at IS NOT NULL
    AND fulfilled_at <= delivery_slot_deadline`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `recalculate_vendor_rating_stats(p_vendor_id uuid, p_alert_admin boolean)`

- **Latest migration:** `20260701000001_fix_full_schema_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT count(*)::integer, round(avg(rating)::numeric, 1) IF v_review_count = 0 OR v_avg_rating IS NULL THEN UPDATE public.vendors RETURN; SELECT low_rating_admin_notified UPDATE public.vendors v
- **Tables read:** vendor_reviews, vendors
- **Tables written:** vendors
- **Identity verification:** WHERE samples: `WHERE vr.vendor_id = p_vendor_id` | `WHERE id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/lib/vendorRating.ts

### `record_user_referral_reward(p_referrer_vendor_id uuid, p_user_phone text, p_credit_amount numeric)`

- **Latest migration:** `20260701000001_fix_full_schema_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'user_phone_required'; IF p_credit_amount IS NULL OR p_credit_amount <= 0 THEN RAISE EXCEPTION 'invalid_credit_amount'; IF NOT EXISTS ( SELECT 1 FROM public.vendors v WHERE v.id = p_referrer_vendor_id RAISE EXCEPTION 'vendor_not_found'; INSERT INTO public.referrals (
- **Tables read:** vendors
- **Tables written:** referrals, vendor_credits
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE v.id = p_referrer_vendor_id
  ) THEN
    RAISE EXCEPTION 'vendor_not_found'` | `WHERE id = v_referral_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (referrals, vendor_credits) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/lib/referral.ts

### `register_vendor(p_name text, p_shop_name text, p_category text, p_phone text, p_upi_id text, p_service_mode text, p_vendor_type text, p_vendor_note text, p_latitude double, p_longitude double, p_referral_code text, p_profile_status text, p_category_ids uuid[], p_category_service_modes text[], p_upi_qr_url text, p_upi_qr_payee_id text)`

- **Latest migration:** `20260708000001_phone_format_and_auth_user_phone.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public.check_and_log_rate_limit('register_vendor', 'phone', p_phone, 3, 300) THEN RAISE EXCEPTION 'rate_limited: too many registration attempts, please wait a few minutes' USING ERRCODE = 'P0001'; IF trim(p_phone) !~ '^[6-9][0-9]{9}$' THEN RAISE EXCEPTION 'invalid_phone_format: phone must be a 10-digit Indian mobile number' USING ERRCODE = 'P0001'; IF v_cat_count > 0 AND ( RAISE EXCEPTION 'category_service_modes length must match category_ids length'; IF v_profile_status NOT IN ('draft', 'complete') THEN RAISE EXCEPTION 'profile_status must be draft or complete';
- **Tables read:** —
- **Tables written:** vendor_categories, vendor_verification, vendors
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body.
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (vendor_categories, vendor_verification, vendors) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/lib/supabase.ts

### `save_saved_vendor(p_vendor_id uuid, p_category text, p_nickname text, p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN RAISE EXCEPTION 'identity_required'; INSERT INTO public.saved_vendors (device_id, vendor_id, category, nickname, user_phone)
- **Tables read:** —
- **Tables written:** saved_vendors
- **Identity verification:** Calls customer ownership helper. **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: saved_vendors.
- **Called from src/:** src/components/RadarVendorCard.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `set_feed_discovery_radius(p_user_phone text, p_radius_km integer)`

- **Latest migration:** `20260702000003_feed_reader_radius_preference.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF p_radius_km IS NOT NULL AND p_radius_km <= 0 THEN RAISE EXCEPTION 'invalid_radius'; INSERT INTO public.app_users (phone, feed_discovery_radius_km)
- **Tables read:** —
- **Tables written:** app_users
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body.
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: app_users.
- **Called from src/:** src/pages/Settings.tsx

### `set_request_fulfilled_at()`

- **Latest migration:** `20260614000006_delivery_on_time_rate.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** no
- **What it does:** IF NEW.status = 'fulfilled' AND (OLD.status IS DISTINCT FROM 'fulfilled') THEN RETURN NEW;
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** See SQL body in latest migration file.
- **Grants:** GRANT anon
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)

### `set_requests_updated_at()`

- **Latest migration:** `20260601160000_requests_updated_at.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** no
- **What it does:** return new;
- **Tables read:** —
- **Tables written:** —
- **Identity verification:** See SQL body in latest migration file.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** No direct writes detected (may use helpers/triggers).
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `set_user_device_feed_notifications(p_user_phone text, p_device_id text, p_enabled boolean)`

- **Latest migration:** `20260701000002_drop_duplicate_function_overloads.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF p_device_id IS NULL OR trim(p_device_id) = '' THEN RAISE EXCEPTION 'device_id_required'; UPDATE public.user_devices ud updated_at = now() RETURNING ud.feed_notifications_enabled INTO v_enabled; IF NOT FOUND THEN
- **Tables read:** —
- **Tables written:** user_devices
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id)
  RETURNING ud.feed_notifications_enabled INTO v_enabled`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_devices.
- **Called from src/:** src/hooks/useFeedNotificationsEnabled.ts

### `submit_customer_feed_post(p_user_phone text, p_type text, p_content text, p_expires_at timestamptz, p_image_url text, p_lat double, p_lng double, p_recommended_vendor_id uuid, p_recommended_vendor_name text, p_recommended_vendor_phone text, p_reach_radius_km numeric)`

- **Latest migration:** `20260702000003_feed_reader_radius_preference.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'user_phone_required'; IF NULLIF(trim(p_content), '') IS NULL THEN RAISE EXCEPTION 'content_required'; IF v_type IN ('announcement', 'recommendation') AND v_expires_at IS NULL THEN INSERT INTO public.feed_posts ( RETURNING id INTO v_id; RETURN v_id;
- **Tables read:** —
- **Tables written:** feed_posts
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body.
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: feed_posts.
- **Called from src/:** src/pages/LocalFeed.tsx

### `submit_feed_reply(p_post_id uuid, p_user_phone text, p_content text)`

- **Latest migration:** `20260630000001_fix_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'user_phone_required'; IF v_content IS NULL THEN RAISE EXCEPTION 'content_required'; IF NOT EXISTS (SELECT 1 FROM public.feed_posts fp WHERE fp.id = p_post_id) THEN RAISE EXCEPTION 'post_not_found'; INSERT INTO public.feed_replies (post_id, user_phone, content) RETURNING id INTO v_id;
- **Tables read:** feed_posts
- **Tables written:** feed_replies
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE fp.id = p_post_id) THEN
    RAISE EXCEPTION 'post_not_found'`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: feed_replies. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/LocalFeed.tsx

### `submit_vendor_review(p_vendor_id uuid, p_request_id uuid, p_user_phone text, p_device_id text, p_rating int, p_review_text text, p_service_mode text)`

- **Latest migration:** `20260630000001_fix_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'user_phone_required'; IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'invalid_rating'; IF EXISTS ( SELECT 1 FROM public.vendor_reviews vr WHERE vr.request_id = p_request_id RAISE EXCEPTION 'review_already_exists'; INSERT INTO public.vendor_reviews (
- **Tables read:** vendor_reviews
- **Tables written:** vendor_reviews
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE vr.request_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'review_already_exists'`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_reviews. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/RatingSheet.tsx

### `submit_vendor_verification(p_vendor_id uuid, p_vendor_phone text, p_check_type text, p_doc_url text)`

- **Latest migration:** `20260701000005_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF NOT EXISTS ( SELECT 1 FROM public.vendors v RAISE EXCEPTION 'not_found_or_unauthorized'; UPDATE public.vendor_verification INSERT INTO public.vendor_verification (
- **Tables read:** vendors
- **Tables written:** vendor_verification
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.id = p_vendor_id AND v.phone = v_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized'` | `WHERE vendor_id = p_vendor_id
    AND check_type = p_check_type
    AND is_latest = true`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_verification. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/VendorMode.tsx

### `unsave_saved_vendor(p_vendor_id uuid, p_device_id text, p_user_phone text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN RAISE EXCEPTION 'identity_required'; DELETE FROM public.saved_vendors sv
- **Tables read:** saved_vendors
- **Tables written:** saved_vendors
- **Identity verification:** Calls customer ownership helper. **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE sv.vendor_id = p_vendor_id
    AND (
      (p_user_phone IS NOT NULL AND sv.user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND sv.device_id = p_device_id)
    )`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: saved_vendors. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/NeighbourSheet.tsx, src/components/RadarVendorCard.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `update_user_address(p_user_phone text, p_address_id uuid, p_address_text text, p_label text)`

- **Latest migration:** `20260701000005_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF NULLIF(trim(p_address_text), '') IS NULL THEN RAISE EXCEPTION 'address_required'; UPDATE public.user_addresses IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** —
- **Tables written:** user_addresses
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE id = p_address_id
    AND user_phone = v_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_addresses.
- **Called from src/:** src/pages/Settings.tsx

### `update_user_device_location(p_user_phone text, p_device_id text, p_last_lat double, p_last_lng double)`

- **Latest migration:** `20260701000002_drop_duplicate_function_overloads.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF p_device_id IS NULL OR trim(p_device_id) = '' THEN RAISE EXCEPTION 'device_id_required'; UPDATE public.user_devices ud updated_at = now() IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** —
- **Tables written:** user_devices
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity. WHERE samples: `WHERE ud.user_phone = trim(p_user_phone)
    AND ud.device_id = trim(p_device_id)`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_devices.
- **Called from src/:** src/lib/pushNotifications.ts

### `update_vendor_review(p_review_id uuid, p_user_phone text, p_rating int, p_review_text text)`

- **Latest migration:** `20260630000001_fix_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'user_phone_required'; IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'invalid_rating'; SELECT vr.created_at IF NOT FOUND THEN RAISE EXCEPTION 'review_not_found_or_not_owned'; IF v_created_at < (now() - interval '7 days') THEN
- **Tables read:** vendor_reviews
- **Tables written:** vendor_reviews
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE vr.id = p_review_id
    AND vr.user_phone = v_phone` | `WHERE vr.id = p_review_id
    AND vr.user_phone = v_phone
  RETURNING * INTO v_row`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_reviews. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/MyOrders.tsx

### `upsert_app_user(p_phone text, p_lang text)`

- **Latest migration:** `20260701000005_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; INSERT INTO public.users (phone, last_active) IF p_lang IS NOT NULL AND p_lang IN ('en', 'hi', 'mr') THEN UPDATE public.app_users
- **Tables read:** —
- **Tables written:** app_users, users
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE phone = v_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (app_users, users) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/lib/supabase.ts

### `upsert_user_device(p_user_phone text, p_device_id text, p_fcm_token text, p_last_lat double, p_last_lng double)`

- **Latest migration:** `20260701000002_drop_duplicate_function_overloads.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_user_phone IS NULL OR trim(p_user_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF p_device_id IS NULL OR trim(p_device_id) = '' THEN RAISE EXCEPTION 'device_id_required'; IF p_fcm_token IS NULL OR trim(p_fcm_token) = '' THEN RAISE EXCEPTION 'fcm_token_required'; INSERT INTO public.user_devices ( updated_at
- **Tables read:** —
- **Tables written:** user_devices
- **Identity verification:** **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. Uses `p_device_id` parameter for device-scoped identity.
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_devices.
- **Called from src/:** src/lib/pushNotifications.ts

### `vendor_accept_order(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text, p_from_status text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests r RETURN v_updated > 0;
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND r.status = p_from_status
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_cancel_order(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text, p_cancel_reason text, p_cancel_appointment boolean)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests r IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_clear_order_edited(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public._vendor_owns_request(p_request_id, p_vendor_id, p_vendor_phone) THEN RAISE EXCEPTION 'not_found_or_unauthorized'; UPDATE public.requests
- **Tables read:** —
- **Tables written:** requests
- **Identity verification:** Calls `_vendor_owns_request(...)`. **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE id = p_request_id
    AND is_edited = true`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_confirm_appointment(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests r IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_decline_booking(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text, p_cancel_reason text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests r IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_delete_menu_item(p_vendor_id uuid, p_vendor_phone text, p_item_id uuid)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** DELETE FROM public.vendor_menu_items mi IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendor_menu_items
- **Tables written:** vendor_menu_items
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_menu_items. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_dismiss_requests(p_vendor_id uuid, p_vendor_phone text, p_request_ids uuid[])`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN RETURN; UPDATE public.requests r
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = ANY (p_request_ids)
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_edit_bill(p_bill_id uuid, p_vendor_id uuid, p_vendor_phone text, p_new_items jsonb, p_reason text, p_confirmed_late_edit boolean, p_confirmed_customer_credit boolean)`

- **Latest migration:** `20260704000003_khata_credit_gates_and_refund.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT EXISTS ( SELECT 1 RAISE EXCEPTION 'unauthorised'; SELECT IF NOT FOUND THEN RAISE EXCEPTION 'bill_not_found'; IF v_bill.payment_status = 'void' THEN RAISE EXCEPTION 'bill_void';
- **Tables read:** khata_ledger, order_bills, order_items, vendors
- **Tables written:** bill_edit_audit, khata_ledger, khata_transactions, order_bills, order_items
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'unauthorised'` | `WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (bill_edit_audit, khata_ledger, khata_transactions, order_bills, order_items) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/BillEditSheet.tsx

### `vendor_fulfil_order(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests r IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.id = p_request_id
    AND r.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_hide_feed_post(p_vendor_id uuid, p_vendor_phone text, p_post_id uuid)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.feed_posts fp IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** feed_posts
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE fp.id = p_post_id
    AND fp.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: feed_posts. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_insert_menu_items(p_vendor_id uuid, p_vendor_phone text, p_items jsonb)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_vendor_phone IS NULL THEN RAISE EXCEPTION 'identity_required'; IF NOT EXISTS ( SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone RAISE EXCEPTION 'not_found_or_unauthorized'; INSERT INTO public.vendor_menu_items (
- **Tables read:** vendors
- **Tables written:** vendor_menu_items
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized'`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_menu_items. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_mark_bill_paid(p_bill_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.order_bills ob IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** order_bills
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: order_bills. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_mark_customer_khata_bills_paid(p_vendor_id uuid, p_vendor_phone text, p_customer_phone text)`

- **Latest migration:** `20260701000001_fix_full_schema_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT EXISTS ( SELECT 1 FROM public.vendors v RAISE EXCEPTION 'not_found_or_unauthorized'; UPDATE public.order_bills ob RETURN v_count;
- **Tables read:** vendors
- **Tables written:** order_bills
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.id = p_vendor_id AND v.phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized'` | `WHERE ob.vendor_id = p_vendor_id
    AND ob.user_phone = trim(p_customer_phone)
    AND ob.payment_mode = 'khata'
    AND ob.payment_status = 'unpaid'`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: order_bills. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/LedgerView.tsx

### `vendor_mark_sent_seen(p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000007_fix_remaining_direct_updates.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.requests r
- **Tables read:** vendors
- **Tables written:** requests
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE r.vendor_id = p_vendor_id
    AND r.status = 'sent'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: requests. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_post_offer(p_vendor_id uuid, p_vendor_phone text, p_content text, p_starts_at timestamptz, p_expires_at timestamptz, p_image_url text, p_lat double, p_lng double, p_reach_radius_km numeric)`

- **Latest migration:** `20260702000003_feed_reader_radius_preference.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT EXISTS ( SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone RAISE EXCEPTION 'not_found_or_unauthorized'; INSERT INTO public.feed_posts (
- **Tables read:** vendors
- **Tables written:** feed_posts
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized'`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: feed_posts. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_promote_green_pending(p_vendor_id uuid)`

- **Latest migration:** `20260701000001_fix_full_schema_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendors v RETURN FOUND;
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** WHERE samples: `WHERE v.id = p_vendor_id
    AND v.verification_status IS DISTINCT FROM 'green_pending'
    AND v.is_manual_verified IS NOT TRUE
    AND v.shop_photo_url IS NOT NULL
    AND v.upi_verif`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/lib/vendorGreenReady.ts

### `vendor_record_khata_payment(p_vendor_id uuid, p_vendor_phone text, p_customer_phone text, p_amount numeric, p_note text)`

- **Latest migration:** `20260704000003_khata_credit_gates_and_refund.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_customer_phone IS NULL THEN RAISE EXCEPTION 'customer_phone_required'; IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'invalid_amount'; IF NOT EXISTS ( SELECT 1 RAISE EXCEPTION 'vendor_not_found_or_unauthorized'; SELECT kl.total_outstanding
- **Tables read:** khata_ledger, vendors
- **Tables written:** khata_ledger, khata_transactions
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'vendor_not_found_or_unauthorized'` | `WHERE kl.vendor_id = p_vendor_id
    AND kl.user_phone = v_customer_phone
  FOR UPDATE`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (khata_ledger, khata_transactions) in one function body → atomic unless exception mid-function. Uses `FOR UPDATE` row locking.
- **Called from src/:** src/pages/LedgerView.tsx

### `vendor_record_khata_refund(p_vendor_id uuid, p_vendor_phone text, p_user_phone text, p_amount numeric)`

- **Latest migration:** `20260704000003_khata_credit_gates_and_refund.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_user_phone IS NULL THEN RAISE EXCEPTION 'customer_phone_required'; IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'invalid_amount'; IF NOT EXISTS ( SELECT 1 RAISE EXCEPTION 'vendor_not_found_or_unauthorized'; SELECT kl.total_outstanding
- **Tables read:** khata_ledger, vendors
- **Tables written:** khata_ledger, khata_transactions
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body. WHERE samples: `WHERE v.id = p_vendor_id
      AND v.phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'vendor_not_found_or_unauthorized'` | `WHERE kl.vendor_id = p_vendor_id
    AND kl.user_phone = v_user_phone
  FOR UPDATE`
- **Grants:** GRANT anon
- **Transactional integrity:** Multi-write (khata_ledger, khata_transactions) in one function body → atomic unless exception mid-function. Uses `FOR UPDATE` row locking.
- **Called from src/:** src/pages/LedgerView.tsx

### `vendor_reply_to_review(p_vendor_id uuid, p_vendor_phone text, p_review_id uuid, p_response text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendor_reviews vr IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** vendor_reviews
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE vr.id = p_review_id
    AND vr.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_reviews. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_submit_user_flag(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text, p_user_phone text, p_flag_type text, p_notes text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF NOT public._vendor_owns_request(p_request_id, p_vendor_id, p_vendor_phone) THEN RAISE EXCEPTION 'not_found_or_unauthorized'; INSERT INTO public.user_flags (request_id, vendor_id, user_phone, flag_type, notes)
- **Tables read:** —
- **Tables written:** user_flags
- **Identity verification:** Calls `_vendor_owns_request(...)`. **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. **FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body.
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: user_flags.
- **Called from src/:** src/components/IncomingOrdersSection.tsx

### `vendor_toggle_menu_item_availability(p_vendor_id uuid, p_vendor_phone text, p_item_id uuid)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendor_menu_items mi IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** vendor_menu_items
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_menu_items. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_update_categories(p_vendor_id uuid, p_vendor_phone text, p_category_ids uuid[], p_category_service_modes text[])`

- **Latest migration:** `20260628000013_vendor_update_categories_rpc.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF NOT EXISTS ( SELECT 1 RAISE EXCEPTION 'not_found_or_unauthorized'; IF v_cat_count = 0 THEN RAISE EXCEPTION 'category_ids_required'; IF p_category_service_modes IS NULL
- **Tables read:** vendor_categories, vendors
- **Tables written:** vendor_categories
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized'` | `WHERE vendor_id = p_vendor_id`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_categories. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/VendorMode.tsx

### `vendor_update_customer_name(p_vendor_id uuid, p_vendor_phone text, p_customer_phone text, p_name text)`

- **Latest migration:** `20260630000001_fix_remaining_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF v_customer_phone IS NULL OR v_name IS NULL THEN RAISE EXCEPTION 'invalid_name_or_phone'; SELECT v.phone IF NOT FOUND THEN RAISE EXCEPTION 'vendor_not_found_or_unauthorized'; IF NOT EXISTS ( SELECT 1 SELECT 1
- **Tables read:** khata_ledger, requests, vendors
- **Tables written:** app_users
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE v.id = p_vendor_id
    AND v.phone = p_vendor_phone` | `WHERE kl.vendor_id = p_vendor_id
      AND kl.user_phone = v_customer_phone
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.requests r
    WHERE r.vendor_id = p_vendor_id
      AND `
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: app_users. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/pages/LedgerView.tsx

### `vendor_update_menu_item(p_vendor_id uuid, p_vendor_phone text, p_item_id uuid, p_name text, p_price numeric, p_unit text, p_description text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.vendor_menu_items mi IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_unauthorized';
- **Tables read:** vendors
- **Tables written:** vendor_menu_items
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: vendor_menu_items. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/settings/VendorSettings.tsx

### `vendor_update_own(p_vendor_id uuid, p_vendor_phone text, p_patch jsonb)`

- **Latest migration:** `20260701000001_fix_full_schema_rls_gaps.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN RAISE EXCEPTION 'identity_required'; IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN RAISE EXCEPTION 'patch_required'; UPDATE public.vendors v
- **Tables read:** —
- **Tables written:** vendors
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body.
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Single-table write: vendors.
- **Called from src/:** src/components/settings/VendorSettings.tsx, src/components/vendor/VendorNoteEditor.tsx, src/lib/pushNotifications.ts, src/lib/vendorPatch.ts, src/lib/vendorServiceRadius.ts, src/pages/VendorMode.tsx
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

### `vendor_void_unpaid_bills(p_request_id uuid, p_vendor_id uuid, p_vendor_phone text)`

- **Latest migration:** `20260628000008_fix_remaining_anon_mutations.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** UPDATE public.order_bills ob
- **Tables read:** vendors
- **Tables written:** order_bills
- **Identity verification:** **FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body. WHERE samples: `WHERE ob.request_id = p_request_id
    AND ob.vendor_id = p_vendor_id
    AND ob.payment_status <> 'paid'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone`
- **Grants:** GRANT anon
- **Transactional integrity:** Single-table write: order_bills. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** src/components/BillSheet.tsx

### `warn_pending_orders_near_deadline()`

- **Latest migration:** `20260618000001_fix_expiry_near_deadline_alias.sql`
- **Language:** plpgsql; **SECURITY DEFINER:** yes; **search_path:** public
- **What it does:** SELECT NULLIF(trim(value), '')::integer SELECT NULLIF(trim(value), '')::integer SELECT NULLIF(trim(value), '')::integer SELECT NULLIF(trim(value), '')::integer IF help_accept_timeout_minutes IS NULL THEN RAISE EXCEPTION 'app_config key help_accept_timeout_minutes is missing or invalid'; IF delivery_near_deadline_minutes IS NULL THEN RAISE EXCEPTION 'app_config key delivery_near_deadline_minutes is missing or invalid';
- **Tables read:** app_config, requests, vendors
- **Tables written:** requests, user_notifications
- **Identity verification:** WHERE samples: `WHERE key = 'help_accept_timeout_minutes'` | `WHERE key = 'delivery_near_deadline_minutes'`
- **Grants:** **FLAG: no REVOKE ALL FROM PUBLIC**; **FLAG: no GRANT to anon/authenticated**
- **Transactional integrity:** Multi-write (requests, user_notifications) in one function body → atomic unless exception mid-function. **FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.
- **Called from src/:** **Not called from src/** (cron/trigger/internal only)
- **Suspicious:** Missing REVOKE ALL FROM PUBLIC

---

## Table RLS Policies (final state from migrations)

### `admin_actions`

- **RLS enabled (last migration touch):** yes
- **`admin_actions_owner`** (SELECT)

### `admin_alerts`

- **RLS enabled (last migration touch):** yes
- **`admin_alerts_admin`** (ALL)
  - USING: `public.is_admin_phone(public.auth_user_phone())`

### `app_config`

- **RLS enabled (last migration touch):** yes
- **`app_config_public_read`** (SELECT)

### `app_users`

- **RLS enabled (last migration touch):** yes
- **`app_users_owner_select`** (SELECT)

### `bill_edit_audit`

- **RLS enabled (last migration touch):** yes
- **`bill_edit_audit_vendor_select`** (SELECT)
- **`bill_edit_audit_customer_select`** (SELECT)

### `categories`

- **RLS enabled (last migration touch):** yes
- **`categories_public_read`** (SELECT)

### `category_translations`

- **RLS enabled (last migration touch):** yes
- **`category_translations_public_read`** (SELECT)

### `fcm_delivery_log`

- **RLS enabled (last migration touch):** yes
- **`fcm_log_admin`** (ALL)
  - USING: `public.is_admin_phone(public.auth_user_phone())`

### `feed_flags`

- **RLS enabled (last migration touch):** yes
- **`feed_flags_owner`** (ALL)
  - USING: `flagged_by_phone = public.auth_user_phone()`

### `feed_posts`

- **RLS enabled (last migration touch):** yes
- **`feed_posts_public_read`** (SELECT)
- **`feed_posts_owner_insert`** (INSERT)
- **`feed_posts_owner_modify`** (UPDATE)
  - USING: `user_phone = public.auth_user_phone()`
- **`feed_posts_owner_delete`** (DELETE)

### `feed_replies`

- **RLS enabled (last migration touch):** yes
- **`feed_replies_public_read`** (SELECT)
- **`feed_replies_owner_delete`** (DELETE)

### `khata_ledger`

- **RLS enabled (last migration touch):** yes
- **`khata_ledger_customer`** (SELECT)
- **`khata_ledger_vendor`** (SELECT)

### `khata_transactions`

- **RLS enabled (last migration touch):** yes
- **`khata_transactions_vendor`** (ALL)
  - USING: `vendor_id IN ( SELECT id FROM vendors WHERE phone = public.auth_user_phone() )`
- **`khata_transactions_customer`** (SELECT)

### `order_bills`

- **RLS enabled (last migration touch):** yes
- **`order_bills_vendor`** (ALL)
  - USING: `vendor_id IN ( SELECT id FROM vendors WHERE phone = public.auth_user_phone() )`
- **`order_bills_customer`** (SELECT)

### `order_items`

- **RLS enabled (last migration touch):** yes
- **`order_items_vendor`** (ALL)
  - USING: `request_id IN ( SELECT r.id FROM requests r JOIN vendors v ON v.id = r.vendor_id WHERE v.phone = public.auth_user_phone() )`
- **`order_items_customer`** (SELECT)

### `referrals`

- **RLS enabled (last migration touch):** yes
- **`referrals_owner`** (SELECT)

### `requests`

- **RLS enabled (last migration touch):** yes
- **`requests_customer`** (ALL)
  - USING: `user_phone = public.auth_user_phone()`
- **`requests_vendor`** (ALL)
  - USING: `vendor_id IN ( SELECT id FROM vendors WHERE phone = public.auth_user_phone() )`

### `saved_vendors`

- **RLS enabled (last migration touch):** yes
- **`saved_vendors_owner`** (ALL)
  - USING: `user_phone = public.auth_user_phone()`

### `user_addresses`

- **RLS enabled (last migration touch):** yes
- **`user_addresses_owner`** (ALL)
  - USING: `user_phone = public.auth_user_phone()`

### `user_devices`

- **RLS enabled (last migration touch):** yes
- **`user_devices_select`** (SELECT)

### `user_flags`

- **RLS enabled (last migration touch):** yes
- **`user_flags_owner`** (ALL)
  - USING: `user_phone = public.auth_user_phone()`

### `user_notifications`

- **RLS enabled (last migration touch):** yes
- **`user_notifications_owner`** (ALL)
  - USING: `user_phone = public.auth_user_phone()`

### `users`

- **RLS enabled (last migration touch):** yes
- **`users_owner`** (ALL)
  - USING: `phone = public.auth_user_phone()`

### `vendor_categories`

- **RLS enabled (last migration touch):** yes
- **`vendor_categories_public_read`** (SELECT)
- **`vendor_categories_owner`** (ALL)
  - USING: `vendor_id IN ( SELECT id FROM vendors WHERE phone = public.auth_user_phone() )`

### `vendor_credits`

- **RLS enabled (last migration touch):** yes
- **`vendor_credits_vendor`** (ALL)
  - USING: `vendor_id IN ( SELECT id FROM vendors WHERE phone = public.auth_user_phone() )`

### `vendor_menu_items`

- **RLS enabled (last migration touch):** yes
- **`vendor_menu_items_public_read`** (SELECT)
- **`vendor_menu_items_owner`** (ALL)
  - USING: `vendor_id IN ( SELECT id FROM vendors WHERE phone = public.auth_user_phone() )`

### `vendor_reviews`

- **RLS enabled (last migration touch):** yes
- **`vendor_reviews_public_read`** (SELECT)

### `vendor_verification`

- **RLS enabled (last migration touch):** yes
- **`vendor_verification_owner`** (SELECT)
- **`vendor_verification_public_read_latest`** (SELECT)

### `vendors`

- **RLS enabled (last migration touch):** yes
- **`vendors_public_read`** (SELECT)
- **`vendors_owner`** (ALL)
  - USING: `phone = public.auth_user_phone()`

---

## Indexes by Table

### `_test_otp_capture`
- `_test_otp_capture_phone_created_idx` (phone, created_at DESC)

### `admin_alerts`
- `admin_alerts_one_open_per_function_idx` (function_name)
- `admin_alerts_function_name_resolved_at_idx` (function_name, resolved_at)

### `bill_edit_audit`
- `bill_edit_audit_bill_id_edited_at_idx` (bill_id, edited_at DESC)

### `edge_function_rate_limits`
- `idx_rate_limits_lookup` (function_name, identifier_type, identifier, created_at)

### `fcm_delivery_log`
- `fcm_delivery_log_created_at_idx` (created_at DESC)
- `fcm_delivery_log_notification_type_idx` (notification_type)

### `feed_posts`
- `feed_posts_vendor_id_idx` (vendor_id)
- `feed_posts_created_at_idx` (created_at DESC)
- `feed_posts_expires_at_idx` (expires_at)

### `khata_ledger`
- `khata_ledger_vendor_id_user_phone_key` (vendor_id, user_phone)

### `order_bills`
- `order_bills_request_id_key` (request_id)

### `requests`
- `requests_device_id_idx` (device_id)
- `requests_vendor_id_idx` (vendor_id)
- `requests_user_phone_idx` (user_phone)
- `requests_status_idx` (status)
- `requests_created_at_idx` (created_at DESC)
- `requests_appointment_time_idx` (appointment_time)
- `requests_payment_status_idx` (payment_status)

### `saved_vendors`
- `saved_vendors_device_id_idx` (device_id)
- `saved_vendors_user_phone_idx` (user_phone)

### `user_notifications`
- `user_notifications_user_phone_created_idx` (user_phone, created_at desc)
- `user_notifications_unread_idx` (user_phone, is_read, created_at desc)

### `users`
- **Indexes (from migrations):** none declared in parsed migrations beyond PK (verify live schema)
- **FLAG:** key table — confirm PK-only in production

### `vendor_categories`
- **Indexes (from migrations):** none declared in parsed migrations beyond PK (verify live schema)
- **FLAG:** key table — confirm PK-only in production

### `vendor_credits`
- `vendor_credits_vendor_id_idx` (vendor_id)
- `vendor_credits_disbursed_idx` (disbursed)

### `vendor_reviews`
- `vendor_reviews_vendor_id_idx` (vendor_id)

### `vendors`
- `vendors_is_active_idx` (is_active)
- `vendors_service_mode_idx` (service_mode)
- `vendors_subscription_status_idx` (subscription_status)
- `vendors_category_idx` (category)
- `vendors_is_active_service_mode_idx` (is_active, service_mode)
- **FLAG:** no index on `phone` column in migrations (heavily used in RLS subqueries)

---

## Cross-cutting security notes

- **`auth_user_phone()`** (latest `20260708000001`): strips leading `91` when digit length = 12 after non-digit removal; else returns raw `phone`. Client session uses anon key + localStorage phone; many RPCs trust `p_vendor_phone`/`p_user_phone` matching vendor row — session binding depends on caller passing correct phone.
- **Admin RPCs** gate on `is_admin_phone(auth_user_phone())` or equivalent in function body (see `20260618000006_admin_server_side_auth.sql`).
- **`register_vendor`** validates 10-digit phone + rate limit (`check_and_log_rate_limit`) as of `20260708000001`.
- **Cron/maintenance functions** (`expire_pending_orders`, `warn_pending_orders_near_deadline`, `anonymise_deleted_accounts`, subscription check crons): not called from src/; run via pg_cron.
- **Defense-in-depth:** Vendor/customer write RPCs (SECURITY DEFINER) bypass RLS; direct client INSERT/UPDATE on financial tables should be blocked by RLS — verify `khata_ledger_vendor` is SELECT-only for vendors after `20260630000001` (writes only via RPC).
- **Public SELECT policies:** `vendor_reviews_public_read`, `vendor_menu_items_public_read`, `vendors_public_read`, `categories_public_read`, `feed_posts_public_read` use `USING (true)` or `is_hidden = false` — intentional for radar/feed.
- **Triggers:** `notify_order_bill_trigger`, `set_requests_updated_at`, `set_request_fulfilled_at`, `prevent_direct_admin_column_writes` — internal, not client RPCs.

*End of inventory. No files modified.*