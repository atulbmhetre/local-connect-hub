# Prelaunch Audit

## CRITICAL INCIDENT — Service Role Key Exposure (RESOLVED)

| Field | Status |
|-------|--------|
| Incident | `app_config.service_role_key` was publicly readable under `USING (true)` on TEST and PROD. The exposed values were confirmed to match each project's real service-role key, allowing any anon caller to bypass all RLS. |
| Resolution | Rotated both projects to new publishable/secret key pairs; updated environment files; removed stale hardcoded key literals from `playwright.config.ts`; refactored `scripts/switch-env.mjs` to read keys from environment variables; verified the new keys through automated TEST coverage and the real production-build PROD smoke suite (**5/5 passing**); disabled legacy JWT-based keys; and deleted `service_role_key` and `anon_key` from `app_config` on both projects. |
| Residual | The existing tester APK used by Gajanand/Monika contains the old key and requires a fresh build. |

## Systemic OTP-off Silent-Read Bug (RESOLVED across the app)

| Field | Status |
|-------|--------|
| Root cause | RLS owner policies relied on `auth_user_phone()`, which requires a Supabase Auth session, while the real app identity model is OTP-off (`localStorage` phone/device; no Auth session). Direct owner-table reads therefore silently returned zero rows for real users. Test infrastructure minted real sessions and masked the defect for the project's lifetime. |
| Resolution | Replaced affected direct reads with narrowly scoped, rate-limited `SECURITY DEFINER` RPCs using caller-supplied phone/device or vendor identity; kept RLS restrictive. Live PROD checks against real affected accounts verified all six passes: Home saved neighbours; FirstOpen vendor/customer restore (including two offline vendors previously locked out); My Orders (a real customer's full history was invisible); the complete vendor order/bill/khata path (launch blocker—vendors had never been able to see real orders); vendor secondary reads (stats, background location, deletion status, green-pending enforcement); and remaining customer reads (Home/Radar/feed/address data, wrong-owner notification dedup, and removal of a world-readable address policy). |
| Standing practice | Every future functionality audit must include a live anon, no-session probe. |

## Vendor Trust Tier — CLOSED

Radar now degrades gracefully when its tier query fails instead of crashing search. The previously designed but unrendered customer badge is live as **Verified · Tier**, with a tap-to-detail verification sheet. The admin verification checklist is localized in EN/HI/MR.

## Full Suite Verification

Ran the complete ~700+ Playwright/Vitest suite for the first time this session. All failures traced to test-infrastructure debt (stale mocks, direct-read assertions invalidated by intentional RLS hardening, one stale seed, and one correctly changed policy allowlist); **zero genuine product regressions were found**. Test-infrastructure fixes were committed separately from product changes.

## Progress tracker

| Item | Status |
|------|--------|
| Phase A — Admin Session Auth | SECURITY/INTEGRITY FIXED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |
| Phase 2 progress | **17 of ~52 functionality-inventory entries fully closed.** Vendor Configuration is CLOSED — no open items. Phase A, the app-wide OTP-off sweep, and the service-role key-rotation incident are tracked separately as cross-cutting closures. |
| Next planned Phase 2 target | TBD |

## Lessons for future audit passes

| Lesson | Action |
|--------|--------|
| TEST and PROD can diverge outside version control entirely | Plan periodic direct PROD schema / trigger / function audits — not migration-file review alone |

## Process notes

| Note | Detail |
|------|--------|
| `supabase/migrations-deferred/` ordering friction | Causes recurring `db push` friction against PROD — CLI enforces strict chronological application. Each push after the deferred migration's timestamp needs a manual workaround (direct SQL apply + `migration repair`). Revisit once Part L (FCM cron replacement) is verified and `20260711180001` can move back to active migrations. **This session alone: five separate PROD pushes hit the same workaround — this needs a structural decision next session, not another one-off workaround.** |
| Confirm the linked Supabase project before every push/deploy | Run an explicit project-ref check before every `supabase db push` and `supabase functions deploy`, with no exceptions. A rate-limit migration and two edge functions were pushed to PROD before TEST verification this session because the CLI retained a stale PROD link. The outcome was low-risk and both environments were subsequently verified in sync, but the sequence violated the standing TEST-then-PROD rule. |

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

> **Scope correction (as of this update):** 17 functionality-inventory entries are closed, including Vendor Configuration (CLOSED — no open items). Earlier entries were reviewed primarily against Functionality, Security, DB Integrity, and Test Coverage; do not infer that all 10 dimensions were completed unless a section explicitly says so. Phase A, the app-wide OTP-off sweep, and the key-rotation incident are separate cross-cutting closures.

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

## Order Lifecycle (Help/Delivery/Appointment) — CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| `vendor_void_unpaid_bills` now called on both cancel paths | Was defined but never invoked on cancellation |
| Incoming-orders list no longer silently caps at 20 | Raised to 50 with explicit count + load-more |
| Appointment double-booking constraint deliberately reverted | Product decision: informal-market vendors legitimately serve overlapping appointments via multiple staff/flexible scheduling — replaced with a soft, non-blocking "you have another appointment around this time" indicator |
| Migrations | `20260715160001`, `20260715170001` |

## Notifications — CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| Double-inbox on expiry/near-deadline/referral | New `skip_inbox` param |
| Rate limiting added to previously-unauthenticated notify edges | |
| Vendor FCM dead-token cleanup extended | Previously customer-only |
| SQL-generated notification copy localized EN/HI/MR | New `notification_i18n` table |
| Unread notifications now archived after 180 days | Previously only read rows archived |
| FCM-failure observability added to existing `AdminSystemHealthCard` | |
| Migration | `20260715180001` |

## Local Feed — CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| `notify-feed-post` now respects audience/category targeting | Previously ignored it, pushing vendor-only posts to customers |
| Rate limiting added to post creation | |
| Orphaned storage objects on upload-then-fail cleaned up client-side | |
| Migrations | `20260717120001`, `20260717140001` |

## Referrals — CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| `record_user_referral_reward` reads credit amount server-side from config | Previously trusted a client-supplied amount (tamper risk on the accumulating ledger) |
| Phone/vendor rate limiting added to `process-vendor-referral` | |
| Migration | `20260717150001` |

### Product clarification (by design, not a gap)

| Item | Notes |
|------|-------|
| Referral credits intentionally accumulating (`disbursed: false`) | Pending a future disbursement strategy once subscriptions launch |

## Settings (customer + vendor) — CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) — Performance/Reliability/Device/Localization/Observability/UI-Layout NOT YET REVIEWED |

### Fixed

| Item | Notes |
|------|-------|
| `delete-account` was completely unauthenticated | Any phone could be deleted with just a guessed number — now requires real prior device/usage association plus rate limiting |
| `ensure_user_device_link` RPC created early | Web/no-push users aren't locked out of deleting their own accounts (gap in the first fix attempt, caught before PROD) |
| `subscription_status` / `subscription_id` / `grace_ends_at` blocked from generic `vendor_update_own` patch | Same pattern as `discoverable` / `upi_verified` — closes revenue-leakage risk where a vendor could self-grant active subscription status |
| Vendor owner `name` field fixed | Was silently failing to persist |
| Migrations | `20260717160001`, `20260717170001` |

## Vendor Configuration (Menu Items, Availability Modes, Cancel Reasons) — CLOSED — no open items

### Availability Modes — CLOSED (TEST + PROD)

Confirmed critical discoverability bug: vendors with multiple business types under one account (for example, a Help-mode category plus a Delivery-mode category) were discoverable only under whichever mode the account happened to expose first. Secondary business modes were invisible on Radar.

Fixed with:

- full per-category mode selection during registration and post-registration category management;
- backend reconciliation that preserves authoritative per-category mode sets and prevents category-edit data loss;
- narrowly scoped Radar discovery based on real category-mode membership instead of the single account-level `service_mode` column; and
- immutable persistence of the effective mode on each order, preventing the wrong billing or fulfillment rules from being applied later.

Migration: `20260718100001_per_category_availability_modes.sql`.

### Menu Items — CLOSED (TEST + PROD)

- Menu mutation RPCs are rate-limited by vendor phone, mitigating the known phone-based tampering risk while the broader OTP-off identity limitation remains open.
- Failed menu saves now surface visible errors instead of silently disappearing.
- Paid AI parsing edge functions (`parse-voice-bill` and `parse-image-bill`) are rate-limited against cost abuse.

Migration: `20260719000001_menu_mutation_rate_limits.sql`.

### Cancel Reasons — CLOSED

Single-category shadowing resolved; hidden-vendor fallback logout resolved.

## Radar Search — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |

### Fixed

| Item | Notes |
|------|-------|
| Public vendor reads secured | Replaced `vendors_public_read USING (true)` with a policy requiring `discoverable = true AND is_banned = false AND profile_status = 'complete'`. Direct API callers can no longer bypass app-level filters to read banned, hidden, or incomplete vendor rows. Vendor self-read is preserved separately. |
| Subscription/trial expiry gated in Radar results | No live effect yet because subscriptions are dormant, but search behavior is ready for launch. |
| Silent Track A / Track B result caps made visible | When the 80-row local or 20-row Pan-India cap is reached, Radar tells the user that more results may exist and suggests narrowing the search or category. |
| Radar health observability added | `AdminSystemHealthCard` now surfaces a Radar health signal using recent search/category health data. |
| Category picker localized | `CategoryPicker.tsx` mic-path copy localized in EN/HI/MR. |
| Dead code removed | Removed `radar_expand_25`, `radar_expand_50`, and `radar_expanding_scan`; deleted unused `VendorCard.tsx`. |
| Migration | `20260717180001` |

### Investigation note

Post-fix failures in `browser-radar-requirements.spec.ts` (16/16) were initially attributed to an environment/bootstrap problem without evidence. A structured A/B investigation temporarily restored the old vendors RLS policy and compared the same test under both policies. The test still failed with the old policy, proving the RLS hardening was not the cause.

The actual cause was an unrelated bug introduced in the same edit: a duplicate `getUserPhone` import in `LiveTracking.tsx` caused a JavaScript declaration error and crashed the SPA to a blank page. After removing the duplicate import and restoring the restrictive RLS policy, the complete targeted suite passed **21/21**.

This is a validated example of why unverified explanations for test failures must not be accepted, especially around security-sensitive changes.

### Deliberately deferred

| Item | Notes |
|------|-------|
| Proper slow/2G-network handling for Radar | Progressive loading and reduced query fan-out require a real architecture decision, not a quick patch. |
