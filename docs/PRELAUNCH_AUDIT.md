# Prelaunch Audit

## Progress tracker

| Item | Status |
|------|--------|
| Phase A — Admin Session Auth | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |
| Phase 2 progress | **6 of ~52 functionality-inventory entries reviewed (partial — 4 of 10 dimensions each). ~46 entries not yet reviewed on any dimension.** — Admin Session Auth, Bill/UPI/Khata Payment Flow, UPI Vendor Verification, Live Tracking Secure Call, Ratings & Reviews, Vendor Registration |
| Next planned Phase 2 target | TBD |

## Lessons for future audit passes

| Lesson | Action |
|--------|--------|
| TEST and PROD can diverge outside version control entirely | Plan periodic direct PROD schema / trigger / function audits — not migration-file review alone |

## Process notes

| Note | Detail |
|------|--------|
| `supabase/migrations-deferred/` ordering friction | Causes recurring `db push` friction against PROD — CLI enforces strict chronological application. Each push after the deferred migration's timestamp needs a manual workaround (direct SQL apply + `migration repair`). Revisit once Part L (FCM cron replacement) is verified and `20260711180001` can move back to active migrations. |

## Phase A — Admin Session Auth — SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |
| Vulnerability | Admin RPC auth via caller-supplied `p_admin_phone` matching `app_config.admin_phone` (spoofable) |
| Fix | `20260708000002_admin_session_auth.sql`, `20260708000003_grant_is_admin_session_anon.sql` — `admin_users` + `is_admin_session()`; 17 admin RPCs session-gated |

### Open follow-ups (Phase A)

1. Playwright admin tests still need session-based auth updates.
2. `src/lib/supabase.ts` hardcoded PROD fallback URL/key — remove before launch.
3. Supabase Auth password-recovery Site URL points at localhost — fix before launch.

## Phase 2

> **Scope correction (as of this update):** the six functionalities marked below as closed (Admin Session Auth, Bill/UPI/Khata Payment Flow, UPI Vendor Verification, Live Tracking Secure Call, Ratings & Reviews, Vendor Registration) were reviewed and fixed against **4 of the original 10 audit dimensions only**: Functionality, Security, DB Integrity, and Test Coverage. Performance, Reliability, Device/OS Compatibility, Localization, Observability, and UI/UX Layout have **NOT** been reviewed for any of them. Do not treat "closed" / "SECURITY/INTEGRITY FIXED" below as meaning fully audited against all 10 dimensions — it means the specific bugs found in those 4 dimensions were fixed and verified. A decision on backfilling the remaining 6 dimensions is pending.

## Bill/UPI/Khata Payment Flow — SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

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

## UPI Vendor Verification — SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| `upi_verified` removed from generic `vendor_update_own` patch (`field_not_allowed`) | Migration `20260714120001` |
| New `vendor_verify_upi` RPC — validates UPI format server-side; requires exact match to saved `upi_id` before setting flag | Same migration |
| `upi_id` changes auto-clear `upi_verified` server-side | Same migration |
| Tests | VV-07–11, all passing |

### Deliberately deferred

| Item | Notes |
|------|-------|
| Real PSP / bank penny-drop verification for UPI | External KYC blocker; same category as Razorpay. Badge currently reflects self-attestation only, not bank-verified ownership |

### Notes

| Item | Notes |
|------|-------|
| Future real verification | `vendor_verification` check_type `upi_pennydrop` is the correct slot |
| Audit trail | Possible `upi_self_verify` check_type considered but not added — revisit if formal audit logging is wanted here |

## Live Tracking Secure Call — SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| Real `invokeInitiateCall` wired into `LiveTracking.tsx` (previously a full UI mock claiming "connected" with no real call placed — safety-feature overclaim) | Same path as `AiBridgeSheet.tsx` |
| Explicit confirm dialog before any unmasked `tel:` fallback, in both `LiveTracking.tsx` and `AiBridgeSheet.tsx` (same honesty gap existed in both) | User must opt in; no silent dial |
| New `app_config.exotel_secure_calling_enabled` flag (default `false`) gates both — shows honest "coming soon" until Exotel KYC clears | Migration `20260714180001`; client via `useAppConfig` |
| Tests | 6 new Vitest cases, all passing; one pre-existing test (R5-01) corrected to reflect new default-off behavior |

### Deliberately deferred

| Item | Notes |
|------|-------|
| Real Exotel masked calling itself | External KYC blocker; same category as Razorpay and UPI PSP verification |

## Ratings & Reviews — SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| `submit_vendor_review` now verifies the underlying order is real before allowing a review — checks `request_not_found`, `vendor_mismatch`, `order_not_fulfilled`, `not_found_or_unauthorized` (dual phone/device identity, same pattern as `claim_customer_payment`). Previously only UI-gated; any RPC caller could fabricate reviews for any vendor | Migration `20260715120001` |
| Tests | RV-GATE-01–07, all passing |

### Logged, not fixed

| Item | Notes |
|------|-------|
| Medium, deferred: `recalculate_vendor_rating_stats` has no row lock | Possible race under concurrent submissions; self-correcting; low impact |
| Backlog: no review-flagging / dispute mechanism | Vendors cannot contest a review |

## Vendor Registration — SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| No unique constraint existed on `vendors.phone` (ever, on either environment) — duplicate vendor accounts under the same phone were possible. Added partial unique index `vendors_phone_key` (excludes anonymized `deleted_%` phones) | Migration `20260715140001` |
| False-positive test: VR-02 previously "passed" by coincidentally hitting `vendors_referral_code_key` (reused referral code in test setup) rather than testing phone uniqueness. Rewritten to use distinct referral codes; confirmed genuinely fails pre-fix and passes post-fix | `tests/vendor-registration.spec.ts` |
| Verified zero live duplicate phones on TEST and PROD before applying the constraint | No data cleanup needed |

### Logged, not fixed

| Item | Notes |
|------|-------|
| Medium/Low, deferred: UPI format not re-validated server-side in `register_vendor` | Client-only |
| Medium/Low, deferred: no server-side sanitization on name/shop text fields | Low risk |
