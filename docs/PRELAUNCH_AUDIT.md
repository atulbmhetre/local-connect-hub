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
| Phase 2 progress | **54 of 66 functionality-inventory entries fully closed** (named list and section-to-entries mapping directly below this table). The denominator is the number of `###` entries in `docs/FUNCTIONALITY_INVENTORY.md` — **66** in both the current file and the originally committed version (`41e6519`); the earlier `~52` was an undocumented approximation from early in the audit, now corrected (no inventory items were discovered, added, or removed — only the denominator was made accurate). The numerator is derived by mapping each fully-CLOSED Phase 2 `##` audit section to the distinct `###` inventory entries it wholly closes. Phase A, the app-wide OTP-off sweep, the service-role key-rotation incident, and the Vendor Trust Tier closure (which sits above the Phase 2 divider) are tracked separately as cross-cutting closures and are **not** part of this tally. |
| Next planned Phase 2 target | Resume at the remaining **12**: First-open/phone restore; Phone entry sheet; Session identity (client); Radar vendor card (shared); Legacy vendor card (unused); Home help-order banner; Neighbour (saved vendor) sheet; Khata settings (vendor); Vendor reply to reviews; Admin delete low reviews; Trust warning banner; Verification badge. |

### Phase 2 fully-closed inventory entries (54 of 66)

Computed by mapping each Phase 2 `##` section marked fully CLOSED (not "partial", not "NOT YET REVIEWED") to the distinct `docs/FUNCTIONALITY_INVENTORY.md` `###` entries it wholly closes. Only whole, user-facing inventory entries are counted; dead-code / duplication meta-entries and entries whose core still lives under a partial section are excluded.

| Closing audit section | Inventory `###` entries wholly closed |
|-----------------------|----------------------------------------|
| Radar Search | Geo vendor search (help / delivery / appointment) |
| Vendor Profile & Lifecycle | Vendor onboarding (native); Vendor phone lookup (returning vendor); Go live / offline; Edit shop details; Vendor analytics summary; Banned vendor gate |
| Home & Discovery Entry | Home screen (Index); Landing / app download; Category picker (SOS fallback); SOS button |
| Notifications Client Surfaces | In-app notification bell; Push navigation bridge; Feed push toggle |
| Admin Dashboard & Moderation | Admin dashboard & moderation; System health monitoring |
| App Shell & Bottom Navigation, 404, Privacy Page, Network Error Banner | App shell & bottom navigation; 404 & privacy; Network error banner |
| Bill/UPI/Khata Payment Flow | Send bill (vendor); Edit bill (vendor); Bill edit history; Khata ledger (vendor book); Add bill to khata / khata from order; Customer khata view (My Orders); UPI payment confirm / dispute (vendor); Customer UPI payment sheet; Inline post-fulfillment payment (Parchi) |
| UPI Vendor Verification | Vendor verification checklist |
| Order Lifecycle (Help/Delivery/Appointment) | Incoming orders list & actions; Order list & lifecycle; Help live tracking |
| Referrals | Vendor refer & earn; Customer referral redirect; Referral link capture |
| Ratings & Reviews | Post-order rating sheet |
| Live Tracking Secure Call | AI-Bridge pre-call sheet |
| Vendor Registration | Vendor registration (new shop) |
| Local Feed | Feed reader; Vendor post offer; Feed discovery radius (reader) |
| Settings (customer + vendor) | My Account (customer); MY SHOP (vendor settings); Device permissions; Account deletion; Clear my data |
| Help / Delivery / Appointment Placement & Order Cards | Customer help order (AI-Bridge / neighbour); Delivery order placement; Delivery slot / address on vendor side; Appointment booking; Vendor confirm / decline appointment; Order card pattern |
| Dev Menu & Admin Access Gate | Dev menu (hidden); Admin access gate |

**Total: 1 + 6 + 4 + 3 + 2 + 3 + 9 + 1 + 3 + 3 + 1 + 1 + 1 + 3 + 5 + 6 + 2 = 54 distinct inventory entries.** Vendor Configuration (CLOSED) still contributes 0 additional whole entries — its availability-modes work overlaps the already-counted Geo vendor search entry. **Notifications** (backend entry, distinct from Notifications Client Surfaces) likewise contributes **0** additional inventory entries — the three notification `###` rows were already wholly closed under Notifications Client Surfaces.

**Tracker note — Help/Delivery/Appointment placement + Dev menu / Admin gate (not a net-new inventory discovery):** This pass closes **8** inventory rows that were still open after the prior remaining-dimensions upgrade (**46 → 54** = +6 placement/order-card + +2 dev-menu/admin-gate). Migrations: `20260723120001`, `20260723120002`, `20260723120003`, `20260723140001`. Side-effect (not an inventory row): restored PROD `app_config.anon_key` (publishable) and re-verified `feed_post_after_insert` after the July 18 key-rotation deletion had left feed notify silently no-op.

## Lessons for future audit passes

| Lesson | Action |
|--------|--------|
| TEST and PROD can diverge outside version control entirely | Plan periodic direct PROD schema / trigger / function audits — not migration-file review alone |
| TEST/PROD schema drift — migration file edited after apply | During Batch 2 final verification, `get_local_feed_posts` / `get_local_feed_posts_count` differed between TEST and PROD (TEST missing the `is_banned` author filter) even though `migration list` showed the same version stamps with zero local-only / remote-only rows. Root cause: an earlier draft of `20260722090002` was applied to TEST; the file was later edited in git to restore the ban filter before PROD push; TEST's already-recorded version meant `db push` never re-ran the corrected statements. Caught only by direct `pg_get_functiondef` (+ `schema_migrations.statements` body) comparison — **not** by migration list alone. Fixed with new migration `20260723100001` + FEED-BAN-01/02 regression tests. **Standing rule:** never edit a migration file after any environment has applied it — always create a new migration instead. |
| Order card pattern (architectural debt) | **Standing item:** no shared `OrderCard` exists — customer My Orders and vendor Incoming Orders use divergent inline implementations. Both verified working via existing E2E; inventory row closed as reviewed. Unify only if a future pass needs one card surface. |

## Recently resolved

| Item | Resolution |
|------|------------|
| Client-readable `dev_menu_pin` | Dev “Set phone number” was gated only by a PIN stored in publicly readable `app_config`. Re-gated behind real admin session auth; PIN dialog and `app_config.dev_menu_pin` row removed (`20260723140001`). Verified TEST + PROD. |

## Process notes

| Note | Detail |
|------|--------|
| `supabase/migrations-deferred/` ordering friction | Causes recurring `db push` friction against PROD — CLI enforces strict chronological application. Each push after the deferred migration's timestamp needs a manual workaround (direct SQL apply + `migration repair`). Revisit once Part L (FCM cron replacement) is verified and `20260711180001` can move back to active migrations. **This session alone: five separate PROD pushes hit the same workaround — this needs a structural decision next session, not another one-off workaround.** |
| Confirm the linked Supabase project before every push/deploy | Run an explicit project-ref check before every `supabase db push` and `supabase functions deploy`, with no exceptions. A rate-limit migration and two edge functions were pushed to PROD before TEST verification this session because the CLI retained a stale PROD link. The outcome was low-risk and both environments were subsequently verified in sync, but the sequence violated the standing TEST-then-PROD rule. |

## Process — Parallel Cursor Window Risk (standing rule, permanent)

| Field | Detail |
|-------|--------|
| Risk | Two Claude conversations share one Cursor workspace. `supabase/.temp/project-ref` is a single shared local file, so whichever conversation last ran `supabase link` silently determines the target of the next `db push` / `functions deploy` in *either* conversation — with no warning in the conversation that did not run the link. |
| Confirmed impact | Root cause of at least two accidental early-landed PROD pushes this session. Both were harmless in outcome (additive / nullable schema, no data loss) but were not safe by design. |
| Standing rule (both windows, permanent) | Run `supabase migration list` immediately before every single `db push` / `functions deploy`, in the same breath. Treat any mismatch between expected-pending and actual-pending as an automatic hard stop — do not proceed. |

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

> **Scope correction (as of this update):** 54 functionality-inventory entries are closed, including Vendor Configuration (CLOSED — no open items), the prior remaining-dimensions upgrades through Settings, plus tonight’s Help/Delivery/Appointment placement & order-card section (6) and Dev menu / Admin access gate (2). Earlier entries were reviewed primarily against Functionality, Security, DB Integrity, and Test Coverage; do not infer that all 10 dimensions were completed unless a section explicitly says so. Phase A, the app-wide OTP-off sweep, and the key-rotation incident are separate cross-cutting closures.

## Bill/UPI/Khata Payment Flow — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | Vendor bill create/edit/history, khata ledger + customer khata, customer UPI claim (PaymentSheet + Parchi inline), vendor confirm/dispute |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this flow. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| UPI return-flow unification | PaymentSheet's resume-based "Did you pay?" (Session 63, with regression tests) was the later design vs ParchiSheet's 30s timer (Session 57). Both surfaces now share `UpiPaymentPanel`; Parchi gains disputed-resubmit + QR deep-link payee support. |
| `payment_claimed` vendor notification | Was titled "Pay Now" in the customer's language. New `notifyVendor_paymentClaimed_*` copy (EN/HI/MR); language resolved via `resolve_user_lang` on the vendor phone (same recipient-language pattern as referrals). |
| Bill line-item `unit` input | Data model had `unit` with no UI. Added localized select (kg/litre/pc/…) in BillSheet + BillEditSheet; historical bills without a unit still render correctly. |
| Silent empty / false-zero states | BillSheet khata outstanding no longer defaults to ₹0 on fetch failure (unknown/error state); bill-replace checks `vendor_void_unpaid_bills` return and blocks send on void failure; MyOrders `loadBills` / `loadMyKhata` toast on error and keep last-good data. |
| Observability | `captureError` wired on BillSheet, BillEditSheet, BillEditHistorySheet, `billEdit.ts`, UpiPaymentPanel claim path, LedgerView load paths. |
| Localization | Payment tab labels + QR empty state; MyOrders bill Paid/Unpaid; `khataPaymentModeLabel` Unpaid/Paid — all EN/HI/MR. |
| Performance | LedgerView customer-open lazy-loads full khata history only when requested (cycle-only first). |

## UPI Vendor Verification — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD), with real PSP/bank penny-drop still deliberately deferred |
| Scope | `vendor_verify_upi`, My Business UPI verify UI, trust-badge UPI check copy |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this surface. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Copy honesty | Trust/admin strings (`trust_check_upi_pennydrop` and related) claimed bank-verified "penny-drop". Actual mechanism is format validation + exact match to saved UPI ID. Copy now says so in EN/HI/MR (`Bank account check (UPI penny-drop)` / vendor "UPI ID confirmed" wording). |
| Artificial delay removed | 900ms `setTimeout` before `vendor_verify_upi` in VendorMyBusiness had no functional purpose — removed. |
| Dead key | Unused `vendor_verify_upi_btn` removed after confirming no call sites. |
| Observability | `captureError` on UPI/category verify paths in VendorMyBusiness. |
| Test TB-03 | Trust detail sheet still asserted the old dishonest label; updated to the new honest string and re-run green. |

## Live Tracking Secure Call — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD), with real Exotel masked calling still deliberately deferred |
| Scope | `LiveTracking.tsx` secure-call chrome + `invokeInitiateCall`; shared honesty path with `AiBridgeSheet.tsx` |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this surface. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Call-chrome honesty | Removed fake Mute / Speaker / End Call controls that implied in-app control over a real WebRTC call. This is a PSTN/Exotel bridge — chrome now matches AiBridge's already-honest "answer on your phone" pattern with auto-dismiss. |
| Call-initiation reliability | Real abort/timeout + `captureError` on `invokeInitiateCall` (was `console.log` only on failure). |
| Localization | Remaining hardcoded Live Tracking chrome localized EN/HI/MR. |
| Tests | `LiveTracking.secureCall.test.tsx` updated for the honest overlay. |

## Ratings & Reviews — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | `RatingSheet`, MyOrders rate CTA / dismiss path, `vendorRating.ts` stats sync |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this flow. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Failed-submit must not archive | `RatingSheet` called `onDismiss` after a failed `submit_vendor_review`, which MyOrders treated as markDone — Rate CTA disappeared even though nothing saved. Failures now keep the sheet open for retry. Skip/Issue → dismiss/archive remains confirmed correct (RV-04). |
| Observability + sync retry | `captureError` on RatingSheet submit/issue paths; `syncVendorRatingFromReviews` retries once then `captureError` with context (was silent while the UI still showed success). |
| Localization | Leftover voice-unavailable toast uses shared `home_voice_unavailable`. |
| Tests | New `RatingSheet.test.tsx` covers fail-no-dismiss, success-dismiss, Skip-dismiss. |

## Vendor Registration — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | `register_vendor` / VendorRegistrationWizard, go-live photo gate, selfie verification submission |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this flow. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Photo go-live gate (confirmed product decision) | Selfie + shop photo are now a real server gate via `_assert_vendor_photos_ready` inside `vendor_update_own` — not just a UI nag. A vendor whose photo upload fails can still register, but must successfully retry the photo before going live. Migration `20260722100001`. |
| Selfie verification submission | Wizard now calls `submit_vendor_verification` for the selfie so admin's checklist cannot miss it. |
| Gibberish name check (confirmed product decision) | Loosened Latin-vowel bias in `looksLikeGibberish` so legitimate Indic names are not false-flagged. Unit tests added. |
| Network reliability | `withNetworkRetry` on `register_vendor` (previously had none); soft-fails use `captureError` + warnings instead of claiming success early. |
| Localization | LiveCamera / QR and related reg copy EN/HI/MR. |
| Tests | Go-live fixtures seed required photos; VR-MULTI-01 fixed for current add-business UI (no brand-name field). |

## Order Lifecycle (Help/Delivery/Appointment) — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | Incoming orders (vendor), My Orders (customer), Help live-tracking page surfaces used by this lifecycle |
| Review | Earlier header said CLOSED for Security/Integrity but left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six. **Live Tracking Secure Call** remains a separate section (secure-call / Exotel) and was not upgraded by this pass — only LiveTracking page localization/reliability touched here under Help live tracking. |

### Fixed

| Item | Notes |
|------|-------|
| `vendor_void_unpaid_bills` now called on both cancel paths | Was defined but never invoked on cancellation |
| Incoming-orders list no longer silently caps at 20 | Raised to 50 with explicit count + load-more |
| Appointment double-booking constraint deliberately reverted | Product decision: informal-market vendors legitimately serve overlapping appointments via multiple staff/flexible scheduling — replaced with a soft, non-blocking "you have another appointment around this time" indicator |
| Migrations | `20260715160001`, `20260715170001` |

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| IncomingOrders silent empty | `load()` / `loadBillsForOrders` no longer wipe to a false-empty list on RPC error — preserve last-good state + NetworkErrorBanner retry. |
| Poll + Realtime double-load | 30s poll and Realtime shared a `silentRefresh` debounce so the same change does not trigger two full reloads. MyOrders poll+Realtime confirmed no equivalent double-load (Realtime patches in place). |
| MyOrders reviews load | `loadMyReviews` ignored errors (could blank already-rated orders on a failed poll). Now `captureError` + toast + preserve last-good map. |
| Observability | `captureError` across IncomingOrdersSection, MyOrders, LiveTracking, ParchiSheet side paths. |
| Localization | LiveTracking EN surface (~40 `liveTracking_*` keys EN/HI/MR); MyOrders Paid/Unpaid; voice-unavailable toasts. |
| Deliberate one-tap (documented, not changed) | Vendor Dismiss / Mark Done / Confirm Payment and same-day post-call appointment cancel intentionally skip confirmation dialogs — one-line code comments added so future audits do not re-flag. |
| Test investigation (not caused by this pass) | LOC-REQ-05, MO-DEL-05, MO-BOOK-05, RV-REQ-07, RV-REQ-08 failed with help-mode CTA copy ("Vendor Helped Me"). Real A/B: identical failures on clean HEAD — pre-existing fixture/`service_mode` issue; not fixed here; flagged for future triage. |

## Notifications — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | Notify edge functions (`notify-user` / `notify-vendor` / `notify-admin` / `notify-feed-post` / `warn-near-deadline` / `check-vendor-subscriptions`), FCM delivery logging, AdminSystemHealthCard backend health sections, `vendor_devices` multi-device push |
| Review | Earlier Security/Integrity (and related backend) closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. Distinct from **Notifications Client Surfaces** (bell / push bridge / feed toggle), which is already fully CLOSED. This remaining-dimensions pass closes those six for the backend path. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| AdminSystemHealthCard early-return | One failing section no longer blanked every section after it — independent section loading + tests. |
| Vendor multi-device push (confirmed decision to build now) | New `vendor_devices` table (migrated from single-token `vendors.fcm_token`); `notify-vendor` delivers to every registered device. Customers already had multi-device; vendors were limited to one. Migration `20260722120001`; tests `vendor-devices.spec.ts`. |
| FCM delivery logging | Admin/feed notify paths now log deliveries (previously only user/vendor); vendor FCM logs use the real notification type instead of a hardcoded label. |
| Near-deadline honesty | `warn-near-deadline` marks pushed only when `sent > 0` (was marking success even with zero tokens). |
| Subscriptions edge | `check-vendor-subscriptions` payload / `skip_inbox` fixed ahead of subscriptions going live. |
| Edge redeploys | `notify-vendor`, `notify-admin`, `notify-feed-post`, `warn-near-deadline`, `check-vendor-subscriptions`. |

## Local Feed — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | `LocalFeed.tsx` reader, `get_local_feed_posts` / notify audience, discovery-radius prefs, vendor offers |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this flow. |

### Fixed

| Item | Notes |
|------|-------|
| `notify-feed-post` now respects audience/category targeting | Previously ignored it, pushing vendor-only posts to customers |
| Rate limiting added to post creation | |
| Orphaned storage objects on upload-then-fail cleaned up client-side | |
| Migrations | `20260717120001`, `20260717140001` |

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Notify-radius parity | Push eligibility used a flat `app_config` default instead of the same per-post `reach_radius_km` + reader discovery-radius logic as the display path. Fixed in `get_feed_post_notify_devices`. Migration `20260722090001`. |
| Category-chip filter | Filtering by an offer vendor's category could hide announcement posts; chips now filter offers only as intended. |
| Pagination | Past the 50-post cap via raised limit ceiling + `get_local_feed_posts_count` (Incoming Orders pattern). Migration `20260722090002`; restore of banned-author filter after TEST apply-drift: `20260723100001` + FEED-BAN-01/02. |
| Discovery-radius save | Revert-on-error when `set_feed_discovery_radius` fails. |
| Performance / i18n / observability | Lazy images; localized dates/push body text; `captureError` on load paths. |

## Referrals — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD), with admin referrer→referee visibility explicitly deferred |
| Scope | `referral.ts` / `apply_user_referral`, ReferralRedirect, vendor Refer & Earn credits display |
| Review | Earlier header said CLOSED for Security/Integrity but left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six. |

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

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Create-success / reward-fail trap | If `create_referred_user` succeeded but reward recording failed, retries saw the user and silently no-op'd — credit permanently lost. New atomic `apply_user_referral` completes the reward on retry; dedupes on existing `referrals` row (`already_rewarded`) so no double credit. Migration `20260721090001` (verified on TEST + PROD). |
| Per-recipient notification language | Vendor "you earned credit" notification was worded from the joiner's device language. RPC now returns `vendor_lang` via `resolve_user_lang`; client picks vendor-locale copy. Joiner-facing messages stay on the joiner's locale. |
| ReferralRedirect UX | Was blank while awaiting and silent on failure. Now loading UI + error toast (`referral_apply_failed`). |
| False ₹0 credits | Settings referral-credits fetch error no longer shows ₹0 — unknown/unavailable state (`referral_credits_unavailable`). |
| Observability | `captureError` in `referral.ts` / related Settings fetch paths. |
| Tests | `tests/referral-reward-retry.spec.ts` (RF-RETRY-01..04). |

### Deliberately deferred

| Item | Notes |
|------|-------|
| Admin referrer→referee visibility | No admin surface clearly showing who referred whom (names/phones, not raw IDs). Discussed with Atul; deferred as non-urgent — not built under this ticket. |

## Settings (customer + vendor) — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | Customer Settings (standing, addresses, prefs), vendor Settings load/extras, Clear My Data, permission dialogs, delete-account hardening (prior Security pass) |
| Review | Earlier Security/Integrity closure left Performance / Reliability / Device / Localization / Observability / UI-Layout as NOT YET REVIEWED. This remaining-dimensions pass closes those six for this surface. |

### Fixed

| Item | Notes |
|------|-------|
| `delete-account` was completely unauthenticated | Any phone could be deleted with just a guessed number — now requires real prior device/usage association plus rate limiting |
| `ensure_user_device_link` RPC created early | Web/no-push users aren't locked out of deleting their own accounts (gap in the first fix attempt, caught before PROD) |
| `subscription_status` / `subscription_id` / `grace_ends_at` blocked from generic `vendor_update_own` patch | Same pattern as `discoverable` / `upi_verified` — closes revenue-leakage risk where a vendor could self-grant active subscription status |
| Vendor owner `name` field fixed | Was silently failing to persist |
| Migrations | `20260717160001`, `20260717170001` |

### Remaining dimensions (Performance / Reliability / Device / Localization / Observability / UI-Layout) — CLOSED

| Item | Notes |
|------|-------|
| Clear My Data rebuild (confirmed retention scope with Atul) | Replaced piecemeal client deletes (addresses/devices only) with atomic SECURITY DEFINER `clear_my_data`. **Retained:** orders/bills/khata, referral credits, `users` ban/warn/trust, `user_flags` (no-show/fake), review rating contribution. **Cleared:** notifications, addresses, profile prefs, saved neighbours, feed/review text, device tokens, local `aaspaas:*` keys. Dialog copy now matches real behavior. Migration `20260722140001`; tests CMD-01..06. |
| False-good Account Standing | Trust RPC failure no longer shows a false “good” badge — genuine unavailable state. |
| Vendor Settings load | No longer stuck on infinite loading on fetch failure; retry + failed flags for menu/addresses/reviews extras. |
| Permissions dialog | “Open Settings” now opens device settings (`App.openUrl('app-settings:')`) instead of only dismissing. |
| Observability | Additional `captureError` on standing / vendor extras / clear-data / address paths. |

## Help / Delivery / Appointment Placement & Order Cards — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD, all 10 dimensions) |
| Scope | Customer help / delivery / appointment placement (`ParchiSheet` + shared `create_customer_request`), vendor-side delivery slot/address display, vendor confirm/decline appointment, and the (absent) shared order-card pattern |
| Review | Distinct from **Order Lifecycle** (incoming list, My Orders list, Help live tracking) and **Live Tracking Secure Call**. This pass closes the placement → vendor-notify → confirm/decline path end-to-end. |

### Fixed

| Item | Notes |
|------|-------|
| Client-fired `invokeNotifyVendor` after create | Violated the standing “notifications always server-triggered” rule. Replaced with AFTER INSERT trigger `request_after_insert_notify_vendor` → vendor inbox always + best-effort FCM via `notify-vendor` (`skip_inbox`) when `app_config.anon_key` is present. Migrations `20260723120001`, `20260723120003`. |
| Confirm/decline race | `vendor_confirm_appointment` / `vendor_decline_booking` now require `appointment_status = 'pending'`; second action raises `already_actioned` (no silent overwrite). Migration `20260723120002`; UI toast + silent reload. |
| Double-submit window | ParchiSheet keeps `sending` through trust→RPC `finally` so rapid taps cannot place twice. |
| Tests | New Help-mode placement Playwright (`PS-HELP-02`); slot enum fixture strings corrected (SLOT-02/03, DM-01, ED-07); `AP-GUARD-01` + `NOTIFY-REQ-01`. |
| Observability / i18n | `captureError` on create/confirm/decline failures; hardcoded-English help-unavailable toast → i18n; vendor appointment date uses app locale. |

### Logged, not fixed

| Item | Notes |
|------|-------|
| Order card pattern | **No shared OrderCard component exists.** Customer My Orders and vendor Incoming Orders each use divergent inline card markup. Real but non-blocking architectural debt — both paths independently verified working via existing E2E. Not unified this pass. |

### Side-effect (not an inventory entry)

| Item | Notes |
|------|-------|
| `feed_post_after_insert` silent PROD no-op | Broken since the July 18 `anon_key` / `service_role_key` deletion from `app_config` (trigger early-returns when key missing). Restored publishable `sb_publishable_…` into PROD `app_config.anon_key` (service-role upsert, same method as TEST). Live PROD probe: insert → `max_resp_id` +1, response `200` `{"notified":0}`. Same-push verified with request-notify E2E. |

## Dev Menu & Admin Access Gate — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD, all 10 dimensions) |
| Scope | Hidden Settings 7-tap Admin tab reveal; “Set phone number (dev)” identity override; admin email/password gate |
| Review | **Admin access gate** was already correctly closed in an earlier session (`is_admin_session()` / `auth.uid()`, no remaining `p_admin_phone` string-comparison auth gate on live PROD admin RPCs — reconfirmed tonight with a full RPC sweep). This pass only fixed the Dev menu gap and formally closes both inventory rows. |

### Fixed

| Item | Notes |
|------|-------|
| Dev phone override gated only by client PIN | `dev_menu_pin` was world-readable under `app_config` public SELECT; PIN compared locally. Re-gated “Set phone number (dev)” behind real admin session (`isAdmin` / `is_admin_session()`). Removed PIN dialog path; 7-tap still only reveals Admin tab (login still required). |
| `dev_menu_pin` removed | Dropped from `admin_update_app_config` whitelist + deleted `app_config` row. Migration `20260723140001`. Verified TEST + PROD (`pin_rows = 0`). Playwright DEV-PHONE-01/02 on TEST; PROD via production-build preview (`playwright.prod-dev-phone.config.ts`). |

### Confirmed correct (no change needed)

| Item | Notes |
|------|-------|
| Admin RPC auth | Every live PROD `admin_*` / `get_admin*` / `log_admin_action` mutator gates on `is_admin_session()`; zero RPCs still hard-gate on `IF NOT is_admin_phone(...)`. `p_admin_phone` remains audit/label-only. Residual: two table RLS policies (`admin_alerts`, `fcm_delivery_log`) still use `is_admin_phone(auth_user_phone())` — not RPC auth. |

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

## Admin Dashboard & Moderation — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD), with one explicitly deferred dormant-subscription integration |
| Scope | `Settings.tsx` Admin tab, `AdminSystemHealthCard.tsx`, and the `admin_*` / `get_admin_*` RPC family |
| Review | Completed across all 10 audit dimensions: Functionality, Security, DB Integrity, Test Coverage, Performance, Reliability, Device, Localization, Observability, and UI/Layout |

### Fixed

| Item | Notes |
|------|-------|
| Flagged Users RLS bug | The Admin tab's direct `.from("users")` query was silently filtered by `users_owner` RLS, so admins could not see flagged users. Added the session-gated `SECURITY DEFINER` RPC `admin_list_flagged_users`; the real ADMIN-08 Warn flow now passes through the rendered UI without an RPC fallback. |
| `app_config` server whitelist and defaults | Added a server-side whitelist to `admin_update_app_config`, expanded it with seven operational keys, rejected unknown keys with `key_not_allowed`, closed the inherited PUBLIC grant gap on `get_admin_fcm_failure_stats`, and added explicit DB/client fallbacks so every Admin App Config field shows a current or default value rather than an ambiguous blank. |
| Waive-off defense in depth | Protected `waiveoff_percent` and `waiveoff_months_remaining` with the direct-admin-write guard while allowing the gated admin RPC via `app.via_admin_rpc`; added a confirmation dialog and localized EN/HI/MR vendor notifications. |
| Audit logging reliability | `log_admin_action` no longer silently skips rows when the caller label is absent; it derives the label from the authenticated admin session and retains explicit fallbacks. Client audit failures now emit a warning instead of disappearing. |
| Grant consistency | Removed unintended anon/PUBLIC EXECUTE access from session-gated admin and health RPCs; authenticated and service-role access remains where intended. |
| Recommendation lead queue | Added contacted, dismiss, and restore actions; reversible soft dismissal; auto-resolution when a recommended phone onboards; dismissed-view support; audit events; and localized Admin UI copy. |
| Moderation safety and feedback | Added explicit confirmation for destructive category rejection and vendor waive-off actions, plus visible success/error feedback for ban and unban operations. |
| Performance and reliability | Admin list queries retain bounded pagination/caps; recommendation retrieval is bounded and indexed through existing data paths; failed list/config/audit operations surface errors rather than silently succeeding. |
| Device, localization, observability, and UI/Layout | Admin behavior was verified through the real browser UI; new user-facing waive-off and recommendation copy is localized in EN/HI/MR; `AdminSystemHealthCard.tsx` health signals and admin audit records provide operational visibility; layouts and confirmation flows were exercised at the existing responsive Admin-tab surface. |
| `PHASE_D_TEST_DEBT` resolved | Removed the six deferred admin-requirement skips, corrected stale assertions/setup, and proved the affected fixes with targeted failure/pass A/B checks where code changes were required. Added dedicated moderation-hardening coverage, including admin/non-admin/anon authorization cases. |
| Migrations | `20260719120001`, `20260719140001`, `20260719150001` |

### Deliberately deferred

| Item | Notes |
|------|-------|
| Waive-off/subscription-state integration | Deferred until the dormant subscription system is activated; there is no reliable live subscription lifecycle to integrate with yet. |

## Vendor Profile & Lifecycle — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD), with two explicitly deferred integrations |
| Scope | Native onboarding, vendor phone lookup, Go Live/Offline, Edit Shop Details, Vendor Analytics, and the Banned Vendor gate |
| Review | Vendor profile and lifecycle paths were reviewed across client behavior, server-side authorization/integrity, localization, failure handling, and native browser coverage |

### Headline security regression

`vendor_update_own` had lost its `_assert_vendor_not_banned` call in migration `20260719100001`. The existing trigger silently coerced `is_active = false` instead of rejecting the write, masking the regression. A controlled A/B proof reproduced the silent pre-fix behavior, restored the assertion, and verified that banned-vendor updates now raise as intended.

### Fixed

| Item | Notes |
|------|-------|
| Appointment-path ban enforcement | Added the same banned-vendor assertion used by `vendor_accept_order` to confirm, fulfill, cancel, decline, mark-seen, and dismiss appointment RPCs. |
| Settings bypass | `Settings → My Business` now applies the same suspended-vendor gate and suspension UI as Vendor Mode. |
| Customer request creation | `create_customer_request` now enforces vendor not-banned, discoverable, and complete-profile checks server-side, and rejects banned customers; these checks were previously client-only or absent. |
| Category and green-pending phone ownership | Added phone-ownership verification to `attach_pending_category` and both green-pending promotion RPCs. |
| Ban-blind feed | `vendor_post_offer` now rejects banned vendors, and `get_local_feed_posts` filters posts from banned authors. |
| Silent analytics and Go Offline failures | Vendor Analytics now surfaces RPC failures instead of showing misleading zero/empty data; Go Offline no longer proceeds when the blocking-orders check itself fails. |
| Non-atomic Edit Shop Details save | Added `vendor_update_profile_and_categories`, replacing two separate RPC writes with one transactional profile/category update. |
| Stale active badge | Ban-triggered forced-offline handling now reconciles the stale `aaspaas:vendor_active` localStorage flag immediately rather than waiting for a later full page load. |
| Localization gaps | Localized banned-vendor suspension copy, GPS-mismatch feedback, and the Go Live dismiss aria-label in EN/HI/MR; corrected the GPS permission-denied text for already-registered vendors. |
| Native-onboarding coverage gap | `loginAsVendor` had always forced `vendor_onboarded = true`, masking the real native onboarding path. Added a `skipOnboarding` variant and VL-01–05 coverage for onboarding, GPS denial, banned-as-not-found phone lookup, Settings ban-gating, and shop/category name synchronization. |
| Shop-name source of truth | Consolidated `brand_name` into `shop_name`: removed the separate brand UI, synchronized `vendor_categories.brand_name` whenever `vendor_update_own` patches `shop_name`, and backfilled existing category rows. `brand_name` belongs to `vendor_categories`, not `vendors`. |
| Migration | `20260719180001` |

### Test-maintenance note

GP-07 was updated to accept the stronger permission-denied rejection introduced by the previous audit pass's grant tightening on `get_admin_green_pending_stats`. Its old expectation was stale; this was not a new product regression, and restoring anon access would have reopened a closed authorization gap.

### Deliberately deferred

| Item | Notes |
|------|-------|
| Radar client-side subscription filter | Deferred because subscriptions are dormant and not yet launched; there is no active subscription lifecycle to integrate with. |
| Phone-only vendor identity as a credential | Systemic OTP-off architecture remains blocked on Exotel KYC; this is not specific to Vendor Profile & Lifecycle. |

## Home & Discovery Entry — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | `Index.tsx` (Home), `Landing.tsx`, `CategoryPicker.tsx`, `SOSButton.tsx` |
| Review | Home discovery entry paths were reviewed across client behavior, AI-gateway classification, saved-neighbour RPC hardening, localization, failure handling, and genuine OTP-off browser coverage |

### Headline finding

Home's free-text AI search used a single-guess classifier that could silently auto-route a distressed or off-topic query to a wrong-but-plausible Help category with no confirmation — a real risk on this Help-mode / emergency-adjacent surface. Replaced with a tiered confirmation flow: `ai-gateway` `classify_category` returns a ranked candidate list; Home shows Tier 1 (top 5) → Tier 2 (up to 10) → rephrase → browse-categories fallback. Original search text is preserved throughout (no more discarding it for a literal `Other` placeholder). Exact category-label matches and the government-service hint path are unchanged.

### Fixed

| Item | Notes |
|------|-------|
| Empty SOS tap | SOS with no text now opens the Category Picker sheet (same as empty search), instead of navigating straight to Radar. SOS with text still uses the classify path. |
| Category-existence filter removed | Home's vendor-existence category filter checked whether any vendor was active for a category anywhere, not whether one was reachable near the customer — it never prevented a wasted tap. Radar's real per-vendor radius matching (`distance <= min(customer bracket, vendor's own configured service_radius_km)`) is the true gatekeeper and runs regardless. Home, Picker, and Radar's fallback grid now show the same active-category catalog. Cuts Home's cold-load category queries from 4 to 1. |
| Therapist vs Beautician | Confirmed product decision: permanently distinct categories; vendor/customer choice decides. Added classify-prompt guidance so ambiguous wellness queries (massage / spa / therapy) surface both as candidates instead of the model picking one. Verified live on TEST and PROD against the ranked Groq path. |
| Taxonomy mismatches | Fixed two real drifts: Pharmacy `service_mode` in static `categories.ts`, Beautician mode in AI-gateway metadata. Flagged, not fixed: Therapist/Beautician alias overlap in static aliases — needs a separate architecture decision; out of scope for this pass and explicitly flagged rather than silently dropped. |
| `get_saved_vendors` rate-limit split | Added a distinct `get_saved_vendors_read` bucket at 120/60s so Radar's legitimate dense per-card saved-state refresh does not trip the limiter; mutation RPCs (save/unsave/migrate) and notice read/mark RPCs keep 30/60s. Narrowed return columns (dropped `device_id` from the response). |
| Ban-time notice parity | Banned saved vendors now purge and queue a `vendor_banned` removal notice, matching the existing delete / category-drop pattern. Trigger `vendors_saved_vendor_notice_on_ban` confirmed live on PROD via `pg_trigger`. |
| Load failures vs empty state | Home's saved-neighbourhood and category grid (plus active-orders / help-banner paths) now surface distinct load-failure UI instead of silent empty state, and wire `sentry.ts`'s previously unused `captureError` for the first time in the app. |
| Localization | Localized hardcoded English on Landing ("Link copied!"), voice search, SOS aria-label, saved-tile Online aria-label, NeighbourSheet sr-only description, and saved-tile category subtitles (via `getCategoryLabel`); added suggest-sheet copy in EN/HI/MR. |
| Test coverage | Landing, CategoryPicker, Home SOS click, Home search/grid, genuine OTP-off Home render (previous helper always minted a real Auth session), tiered suggest-sheet Vitest suite, ACW-01 wellness dual-candidate live assert, and SVR / HR hardening coverage including ban-notice and the 120/60s read bucket. |
| Mid-session `GROQ_API_KEY` incident (TEST) | TEST had been missing / incorrectly storing `GROQ_API_KEY`, silently degrading every classify smoke to the Claude single-guess `suggest-category` fallback. Key corrected on TEST; all wellness and path-confirmation probes re-run against the real ranked Groq path afterward. Same incident also unblocked `parse-voice-bill` on TEST. PROD key was already present (set 2026-05-03) and verified live post-deploy. |
| Migrations | `20260719200001`, `20260719210001` |
| Edge function | `ai-gateway` redeployed to TEST and PROD; PROD version 28 verified live (ranked-candidates contract + wellness rule confirmed via download and live smoke). |

### Standing item (not this pass)

31 pre-existing Playwright failures on the shared TEST baseline (order-lifecycle, expiry-cron, notification-copy domains) were investigated via real A/B against a clean stash — identical failures on baseline and with these changes. Confirmed unrelated to this pass, not resolved here, and flagged for future triage.

## Notifications Client Surfaces — CLOSED (TEST + PROD)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD) |
| Scope | Bell UI (`NotificationBell`), push navigation bridge (`PushNavigationBridge` / `notificationNavigation`), feed push toggle, and the client-side notify helpers that feed those surfaces |
| Review | Distinct from the earlier **Notifications — CLOSED** backend entry (inbox write path, `skip_inbox`, edge rate limits, FCM cleanup, `notification_i18n` copy table, archive cron, FCM-failure admin card). That entry left Performance / Reliability / Device / Localization / Observability / UI-Layout as **NOT YET REVIEWED**. This pass closes those client surfaces — it does **not** reopen or redo the backend Notifications work. |

### Headline finding

Atul reported real recurring routing and duplicate-inbox issues that the initial Notifications backend audit alone did not catch. A targeted diagnosis against real inserted rows found four distinct routing bugs (wrong or null destinations), an OTP-off Realtime dead path for the bell (same class as Home's help banner), weaker-than-feed inbox mutation authz, an FCM token collision on shared `device_id`, silent failure paths with no `captureError`, a capped-fetch badge undercount, plus two PROD-severity findings: `notification_i18n` with RLS fully disabled (active anon write-exposure on live copy templates), and a long-standing `new_order` + typeless `notification` duplicate driven by a legacy untracked DB webhook trigger.

### Fixed

| Item | Notes |
|------|-------|
| Bell Realtime dead under OTP-off | `user_notifications` RLS is keyed on `auth_user_phone()`, which is NULL for real OTP-off callers — same root cause as Home's help banner. Poll-based badge/tray refresh is now the source of truth; Realtime kept as a harmless bonus layer. |
| Inbox mutation RPC hardening | Mark / delete / clear previously accepted only `p_user_phone` with no device binding (weaker than the feed-toggle RPC). Hardened to phone + `device_id`, with rate limiting (30/60s) matching other mutation RPCs. |
| FCM token collision / staleness | A new phone on a previously-used `device_id` could leave the prior phone receiving pushes. `upsert_user_device` / `ensure_user_device_link` now clear the token from any other phone sharing that `device_id`. |
| Silent failure → `captureError` | Bell load/mutation failures, push registration failures, and unresolvable push-tap routes were console-only. Wired `captureError` into all three, matching the Home & Discovery pattern. |
| True unread-count RPC | Badge count was previously derived by filtering a capped 100-row client fetch (could undercount past that limit). Added `get_user_unread_notification_count`. Tray only refetches when the sheet is open. |
| Routing: `category_approved` / `category_rejected` | Null route → fell through to Home; now routes to Settings. |
| Routing: low-rating → `review_received` | Reused `order_update` type with copy/destination disagreement; now its own `review_received` type, routed to Settings. |
| Routing: `payment_confirmed` / `payment_disputed` | Confirmed payments routed customers to `/vendor` instead of `/my-orders`; disputes now have their own `payment_disputed` type. |
| Routing: admin `new_vendor` | Routed to `/vendor` instead of `/settings`. VR-E2E-01 had a stale assertion expecting `vendor`; updated to `settings` to match the intentional fix. |
| Route-missing safety net | Non-blocking `captureError` in shared `invokeNotifyUser` / `invokeNotifyVendor` client helpers so a future type shipped without a route cannot silently repeat the `category_approved` bug. |
| Historical `referral_credit` duplicate cleanup | 6 pre-2026-07-17 duplicate inbox rows cleaned on TEST (root cause — double-insert in `process-vendor-referral` — already fixed in source on 2026-07-17). PROD had zero such duplicates. |
| **Urgent:** `notification_i18n` RLS | Active PROD write-exposure: RLS was disabled entirely with full anon/authenticated CRUD grants — any anon caller could alter live notification copy templates app-wide. Enabled RLS with a SELECT-only public-read policy (same pattern as `categories` / `app_config` / `category_translations`). Pushed to PROD ahead of the rest of this pass given severity. |
| `new_order` + typeless `notification` duplicate | Long-standing, previously unexplained PROD pair for the same order (~1.8s apart). Root cause: legacy dashboard-created DB webhook trigger `notify_vendor_on_order` (never in git) fired on every `requests` INSERT across all modes, redundant with ParchiSheet's client notify; also silently dead since the July 18 key rotation (embedded invalid legacy anon JWT). Removed via a git-tracked migration. |
| Admin category-suggestion dual-write | Source-fixed 2026-07-13 but never deployed to PROD; redeployed `suggest-category` (plus `notify-vendor` / `notify-user` / `notify-admin`) and verified live. |
| Test coverage | Push bridge cold-start / unresolvable-route handling, feed-toggle native persistence, phone-spoofing authz on hardened inbox RPCs, bell fetch-fail-to-error-UI, poll-based badge under simulated OTP-off Realtime failure, NRF-01..04 routing-fix specs. |
| Migrations | `20260720120001`, `20260720140001`, `20260720150001`, `20260720160001` |
| Edge functions | `notify-vendor`, `notify-user`, `notify-admin`, `suggest-category` redeployed to PROD |

### Standing items (not this pass)

| Item | Notes |
|------|-------|
| NOTIF-RATE-01 | Investigated via real A/B; pre-existing test-harness bug — mismatched service/anon key header pairing against TEST's `sb_`-style keys causes an early 401 before rate-limit logic runs. Not a product regression; flagged for future test-infra cleanup. |
| IO-DEL-02 | Investigated via real A/B against pre-session code; fails identically (`incoming-accept-btn` not found) — same class as IO-DEL-01/05. Confirmed pre-existing / unrelated; not fixed in this pass. |
| NR-TEST-03 | **A/B-confirmed 2026-07-22:** `network-retry.spec.ts` TEST 3 (My Business service radius retries) — both cases fail identically on clean HEAD (`155e3c3`, full Batch 2 stash) and with Batch 2 applied. Failure: Sonner retry/exhausted toasts never appear after `my-business-save` + aborted `vendor_update_own` route mock (`Connection is slow — still trying…` / `Couldn't connect…`). Not caused by Clear My Data / Settings vendor-load retry changes; flagged for future triage (likely My Business save path or toast wiring vs route abort harness). |

## App Shell & Bottom Navigation, 404, Privacy Page, Network Error Banner — CLOSED (TEST + PROD, frontend-only)

| Field | Detail |
|-------|--------|
| Status | CLOSED (TEST + PROD, frontend-only) |
| Scope | `AppShell` / `BottomNav`, the 404 / not-found route, the in-app Privacy Policy page, and the global Network Error Banner |
| Review | All four are frontend-only surfaces — none perform direct owner-table reads, so the systemic OTP-off silent-read class does not apply here. Confirmed by inspection at every call site. |

### Fixed

| Item | Notes |
|------|-------|
| Stale duplicate Privacy Policy | The in-app Privacy Policy page was a materially incomplete second copy of the canonical policy — missing the OTP, payments, user-rights, and security sections, with a wrong contact and an outdated date. Repointed to the single canonical source instead of maintaining a divergent copy that could drift, and added a Settings link (previously reachable only by typing the direct URL). |
| 404 home link | Now uses client-side navigation instead of a full document reload. |
| Localization | Remaining hardcoded English strings across these surfaces localized. |

### Confirmed correct (no change needed)

| Item | Notes |
|------|-------|
| Network Error Banner classification | Correctly distinguishes genuine network failures from RLS/permission errors at every audited call site — it does not misreport an authorization denial as an offline/network problem. |
| No OTP-off exposure | None of the four surfaces read owner tables directly; the OTP-off silent-read defect cannot manifest here. |
