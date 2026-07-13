# Prelaunch Audit

## Progress tracker

| Item | Status |
|------|--------|
| Phase A — Admin Session Auth | CLOSED (TEST + PROD) |
| Phase 2 functionalities fully closed | **1 of ~52** — Bill/UPI/Khata Payment Flow |
| Next planned Phase 2 target | UPI vendor verification (currently simulated; flagged in functionality inventory) |

## Lessons for future audit passes

| Lesson | Action |
|--------|--------|
| TEST and PROD can diverge outside version control entirely | Plan periodic direct PROD schema / trigger / function audits — not migration-file review alone |

## Phase A — Admin Session Auth

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Vulnerability | Admin RPC auth via caller-supplied `p_admin_phone` matching `app_config.admin_phone` (spoofable) |
| Fix | `20260708000002_admin_session_auth.sql`, `20260708000003_grant_is_admin_session_anon.sql` — `admin_users` + `is_admin_session()`; 17 admin RPCs session-gated |

### Open follow-ups (Phase A)

1. Playwright admin tests still need session-based auth updates.
2. `src/lib/supabase.ts` hardcoded PROD fallback URL/key — remove before launch.
3. Supabase Auth password-recovery Site URL points at localhost — fix before launch.

## Phase 2 — Bill/UPI/Khata Payment Flow

| Field | Detail |
|-------|--------|
| Status | **FULLY CLOSED (TEST + PROD)** |

### Fixed

| Item | Migration / notes |
|------|-------------------|
| Khata payment race (bill-mark atomic inside `vendor_record_khata_payment`) | `20260709120001` |
| UTR format validation (server + client) | `20260709130001` |
| **Critical:** rogue out-of-band `trigger_update_khata_ledger` on PROD only (not in git/migrations; likely Studio). Silent balance-reset after payments. Zero customers affected before fix (verified). Removed + data reconciled | `20260713000001` |
| Server-side khata red-limit enforcement — block new khata bills when customer already ≥ `khata_red_limit`; crossing into red on one bill allowed; `FOR UPDATE` row lock. Tests ABK-08–ABK-11 | `20260713120001` |

### Also while pushing other pending migrations

| Item | Notes |
|------|-------|
| `20260712000001` SQL syntax (missing `)` on `storage.buckets` INSERT) | Fixed before push |
| `20260711180001` FCM cron retirement | Deferred → `supabase/migrations-deferred/`; not for PROD until Part L Capgo verification |

### Remaining notes (non-blocking for this flow)

| Item | Notes |
|------|-------|
| `order_bills` no dedicated `vendor_id` index | Fine at current scale; UI queries by `request_id` |
| Payment/khata RPCs still phone-param auth | Same identity-binding gap as Phase A; pending OTP |
