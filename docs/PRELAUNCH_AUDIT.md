# Prelaunch Audit

## Phase A — Admin Session Auth

- **Vulnerability found:** Admin RPC authorization relied on caller-supplied `p_admin_phone` matching `app_config.admin_phone` (a value also used by client-side gating), so authorization could be spoofed by supplying that phone.
- **Fix implemented:** Migrations `20260708000002_admin_session_auth.sql` and `20260708000003_grant_is_admin_session_anon.sql` introduced `public.admin_users`, `public.is_admin_session()`, and rewrote 17 admin-related RPCs (`admin_*`, `get_admin_dashboard_stats`, `get_recommendations_for_admin`, `log_admin_action`) to authorize via session (`auth.uid()` in `admin_users`) instead of phone matching. Operational scripts added: `scripts/create-admin-user.mjs`, `scripts/reset-admin-password.mjs`. `src/pages/Settings.tsx` updated to session-based admin login/gating.
- **Status:** Fully closed on TEST and PROD.

### Open Follow-ups

1. Playwright admin tests are stale and must be updated for session-based admin auth flow.
2. `src/lib/supabase.ts` still has a hardcoded PROD fallback URL/key path; remove fallback to avoid accidental PROD targeting.
3. Supabase Auth password-recovery Site URL is misconfigured (currently points at localhost) and must be corrected before launch.

## Phase 2 (partial) — Bill/UPI/Khata Payment Flow

- **Fixed (TEST + PROD):** Khata payment zeroing race — bill-mark now atomic inside `vendor_record_khata_payment` (`20260709120001_khata_payment_marks_bills_paid.sql`).
- **Fixed (TEST + PROD):** UTR format validation in `claim_customer_payment` server-side + aligned client-side in `PaymentSheet.tsx` / `ParchiSheet.tsx` via shared `src/lib/validation.ts` (`20260709130001_claim_customer_payment_utr_format.sql`).
- **Verified (PROD):** Zero pre-existing inconsistent khata/bill state; zero invalid stored `payment_utr` values.
- **Open, unconfirmed:** Possible race in `add_bill_to_khata` credit-limit check (read-then-write vs atomic).
- **Open, unconfirmed:** `khata_ledger.total_outstanding` update mechanism not yet confirmed atomic outside the payment-recording path.
- **Open, unconfirmed:** `order_bills` lacks a dedicated `vendor_id` index (fine at current scale; revisit before wider rollout).
- **Known gap, deliberately unchanged:** All payment/khata RPCs still authorize via caller-supplied phone parameter, not a verified session — same identity-binding gap as Phase A, pending OTP.

