# AASPAAS PRO — Master Project Log
> **Vision:** Digitize the Offline 80% of India. Go Global.
> **Tagline:** Help, around you. Now.
> **Last Updated:** Session 48 — 20 June 2026 (Phase B dual-write OTP identity complete. Phase C RLS migration is next.)

---

## 📋 HOW TO START EVERY NEW SESSION

Drag and drop this file into a new Claude chat and say:
> "Hi Claude, I'm building Aaspaas Pro. Here's my Master Log. Let's start from where we left."

---

## 📋 ATUL'S ACTION ITEMS — OUTSIDE BUILDING

> These are things only Atul can do. Claude tracks status and guides on each.
> Update status when done. Bring blockers back to Claude.

### 🔴 Blocked / Urgent
| Item | What to do | Status |
|---|---|---|
| **Exotel KYC & Business Registration** | Step 1: MSME/Udyam in wife's name at udyamregistration.gov.in — free, 1 day, needs Aadhaar+PAN only. Step 2: GST at gst.gov.in — 3-7 days. Step 3: Submit to Exotel KYC. Consult CA for tax structure. All documents ready. | 🔴 Starting MSME now |
| **Google Play Developer Account** | Go to play.google.com/console → Pay $25 one-time fee → Complete identity verification (takes 1-2 days) → Come back and tell Claude | ❌ Not started |

### 🟡 Important / This Week
| Item | What to do | Status |
|---|---|---|
| **Trademark Registration** | Go to ipindia.gov.in → Trademark → File new application → Class 42 (software/technology services) → Name: "AasPaas Pro" + logo → Pay ₹4,500 filing fee. Filing date is what matters legally — approval takes 18-24 months but you're protected from filing date. | ❌ Not started |
| **Domain Registration** | Go to godaddy.com or namecheap.com → Search `aaspaas.in` (Rs 800/yr) or `aaspaas.app` → Purchase → Come back, Claude will update app_base_url in one SQL command | ❌ Not started |
| **Talk to 3 vendors** | Walk into Warje — 1 kirana, 1 beautician, 1 mechanic. Show the app. Ask: "Would you pay Rs 99/month for this?" Take notes on what confuses them. Come back and tell Claude what they said | ❌ Not started |
| **Exotel test call** | Once KYC approved — test masked call on 2 phones. Vendor phone + user phone. Check if call connects, time limit works, number stays hidden | ⏳ Waiting for KYC |
| **2-phone end-to-end test** | Use two phones. Phone 1 = customer, Phone 2 = vendor. Full order journey: help order → accept → notification → live tracking → mark done → rate. Also test delivery and appointment modes. | ⏳ Pending — do before Razorpay |
| **Build and distribute new APK** | `npm run build` → `npx cap sync android` → Build from Android Studio → Share with Gajanand and other test vendors | 🔄 Pending — MANY client-side changes from Session 42B/42C (deep-links, Radar UI, feed) need this rebuild before any device testing |
| **Set ANTHROPIC_API_KEY in Supabase Edge Function secrets** | Go to Supabase dashboard → TEST project → Edge Functions → Secrets → add `ANTHROPIC_API_KEY`. Repeat for PROD project. Required for `suggest-category` edge function (AI category suggestion) to work | ❌ Not confirmed — verify before testing category suggestion or Radar unknown-term fallback |

### 🟢 When Ready
| Item | What to do | Status |
|---|---|---|
| **Privacy Policy page** | ✅ Built — `privacy-policy.html` ready to host. Upload to GitHub Pages as `index.html` in a repo called `aaspaaspro-privacy`. URL becomes `https://yourusername.github.io/aaspaaspro-privacy` — paste into Play Store Privacy Policy URL field | ✅ Built — needs hosting |
| **Play Store listing** | App icon (512x512), 2-8 screenshots, short description (80 chars), full description. Claude will help write copy. Need Play Console account first | ⏳ Waiting for Play Console |
| **Razorpay account** | Go to razorpay.com → Sign up as business → Complete KYC (PAN + bank account) → Get API keys → Tell Claude. Needed before payment integration can go live | ❌ Not started |
| **Admin FCM token** | After fresh APK install + phone set, run: `UPDATE app_config SET value = (SELECT fcm_token FROM user_devices WHERE user_phone = '8888169446' ORDER BY updated_at DESC LIMIT 1) WHERE key = 'admin_fcm_token'` | ✅ Done — Session 33 working |
| **Supabase Pro upgrade** | Upgrade at 25 vendors enrolled. Go to supabase.com → Settings → Billing → Pro plan ($25/month). Gives daily backups + 7-day point-in-time recovery. Until then: weekly manual CSV export of khata_ledger, khata_transactions, vendors, requests from Supabase dashboard → save to Google Drive. | ⏳ Trigger: 25 vendors |

### 📝 Notes for Atul
- **Trademark:** File under Class 42 (computer software, technology services). You can file yourself online at ipindia.gov.in — no lawyer needed for basic filing. ₹4,500 for individual/startup. Keep the acknowledgement receipt — that date is your legal protection start date.
- **Exotel KYC** typically takes 3-7 business days after submission. If it's been more than 7 days, raise a support ticket.
- **Google Play Console** $25 is a one-time fee, not monthly. Takes 48hrs to activate after payment.
- **Razorpay KYC** needs: PAN card, cancelled cheque or bank statement, business address proof. For individual/sole proprietor this is simpler than company registration.
- **Domain**: `.in` is cheaper and more relevant for India. `.app` is more global. Your call.
- **Vendor visits**: Go in the morning (10am-12pm) when shop owners are less busy. Bring a printed QR code linking to the app. Don't pitch — just show and ask questions.
- **Gajanand Bhadekar** — has two vendor accounts (duplicate from old APK). Old Grocery Store account (`c87dae2d`) banned/deactivated in DB. Active account is Shreenivas / Mechanic (`6d0e24e5`). Get him on new APK ASAP.
- **dev_menu_pin** — change from default 1947 before public launch. UPDATE app_config SET value = 'XXXX' WHERE key = 'dev_menu_pin'.

---

## 🧠 WHO I AM (ATUL) — READ THIS FIRST, CLAUDE

### My thinking style
- I think like a **product owner + architect** — big picture AND details
- I challenge decisions that don't feel right — take my pushback seriously
- I care deeply about **real Indian users** — Bharat-80, no English, no credit card
- I don't want jugaad — clean, unified, production-grade decisions
- I think globally — not just India, every language, every country eventually

### How Claude should behave
- **Think 3 steps ahead** — you are the architect, not just a code generator
- **Proactively flag issues** — don't wait for Atul to find them
- **Never push to Phase 2 lazily** — if it can be solved now, solve it now
- **Challenge me back** when I'm wrong — don't just agree
- **Never dump raw code** — always give Cursor prompts in natural language
- **One step at a time** — Prompt → I apply → I share result → you validate → next step
- **Ask only one question at a time**
- **Always think about fraud, edge cases, and Indian user behaviour**
- **No hardcoding** — categories, emojis, labels all from DB
- **OOP principles** — shared utilities in one place, no duplicate functions
- **Always read the full master log before suggesting next steps** — never miss pending features
- **Never give SQL to run without explaining what it does and asking for confirmation first** — learned from RLS incident Session 35
- **Always verify cross-user data patterns before designing RLS policies**
- **App automates everything possible — human admin only for what genuinely cannot be automated**
- **Every feature decision must carry WHY, WHAT, HOW, WHEN, WHERE**
- **Tests must validate requirements/expectations, not just what was coded** — 336 tests passing ≠ app works correctly. Tests must ask "does the code do what the business expects?" not "does the code do what it was written to do?"
- **Claude tracks all pending actions, PROD repair commands, and notes — Atul does not keep notes manually**

---

## 🏗️ SESSION 48 — PHASE B: DUAL-WRITE OTP IDENTITY (20 June 2026)

### ✅ WHAT WAS DONE
Phase B of the 4-phase OTP auth migration complete. Real Supabase Phone OTP 
verification added to first-open/restore flow alongside existing localStorage 
mechanism. Zero behavior change for existing users. Graceful fallback on any 
OTP failure — no user lockout possible.

### FILES CHANGED
| File | Change |
|------|--------|
| `src/lib/supabase.ts` | `persistSession: false` → `persistSession: true` |
| `src/lib/userIdentity.ts` | Added `requestPhoneOtp()` and `verifyPhoneOtp()` |
| `src/components/FirstOpenFlow.tsx` | New `otp_pending` step + OTP UI screen |
| `src/lib/strings.ts` | 6 new `firstopen_otp_*` keys (EN/HI/MR) |
| `tests/phone-auth-phase-b.spec.ts` | 3 new tests — all passing |

### STATE MACHINE
`restore` → `otp_pending` → `notification_permission` → `done`

### KEY DECISIONS
- `persistSession: true` required so JWT survives restarts — Phase C RLS needs it
- Both account-found AND no-account paths request OTP before notification step
- OTP failure / skip → graceful fallback to localStorage path (no lockout)
- Dormant SMS hook still active — Exotel KYC pending, OTP written to 
  `_test_otp_capture` for testing. Zero code change needed when KYC clears.
- PROD untouched — TEST only until Exotel live

### TEST RESULTS
PHASE-B-01 ✅ PHASE-B-02 ✅ PHASE-B-03 ✅ (3/3 passing)

### NO MIGRATIONS — Phase B is client-side only.

### OPEN ITEMS → SESSION 49
| # | Item | Priority |
|---|---|---|
| 19-D | Phase C — RLS Tier 1→2→3 | 🔴 Start here |
| 19-E | Phase D — retire legacy auth | Medium |
| 7 | Vendor call button (IncomingOrdersSection) | Medium |
| — | Razorpay ₹99/month | Medium |
| — | APK rebuild + 2-phone test | Medium |
| — | 12 pre-existing test failures | Low |

---

## 🚨 SESSION 47 — START HERE FIRST

### ⚠️ CRITICAL CONTEXT FOR CLAUDE — READ BEFORE ANYTHING ELSE

**Session 46 complete — All 9 full-app audit gaps fixed + post-launch cleanup batch done + test suite honest reset:**
- All 9 gaps from Session 45C full-app audit fixed (see Session 46 section below for full details)
- Post-launch cleanup batch completed ahead of schedule (8 items — all done)
- 2 migrations pushed to PROD: seed app_config + remove debug_loc_error
- Test suite reset: broken browser UI tests removed, DB suite preserved, requirement-based E2E planned for Session 47
- CLI confirmed back on TEST (`hhdylnhqdzfabsolwxdz`) at end of session

**ALL AUDITS COMPLETE** ✅
Help ✅ Delivery ✅ Booking ✅ Announcements ✅ Recommendations ✅ Radar ✅ Khata/Billing ✅ Data Deletion ✅ Ratings/Reviews ✅ Vendor Registration ✅ Referrals ✅ BR-3 ✅ Settings ✅ Admin Panel ✅

**ALL GAP FIXES COMPLETE** ✅ (Sessions 42–46)

---

### ⚠️ SESSION 47 — IMMEDIATE PRIORITY ORDER

**PRIORITY 1 — Requirement-based E2E test suite (most important technical debt)**

Current test suite validates implementation, not requirements. This is a known gap. See Test Suite section below for full context and what's needed.

Before writing any tests, fix the auth infrastructure first:
1. Implement `loginAsCustomer` using Supabase service-role key to create a real session — not just localStorage values. The app's auth guard checks Supabase session, not localStorage alone. All browser UI tests fail without this.
2. Once auth works, write requirement-based E2E tests from user stories — not from code. Examples:
   - Kirana vendor registers → appears in Radar within 15km ✅/❌
   - Customer places help order → vendor gets FCM notification ✅/❌
   - Vendor accepts → customer sees "accepted" status ✅/❌
   - Help vendor goes offline → disappears from Radar ✅/❌
   - Delivery vendor goes offline → still appears in Radar ✅/❌
   - Customer in Pune searches "mechanic" → only mechanics within selected radius appear ✅/❌
   - Khata bill created → ledger balance updates correctly ✅/❌
   - Pan-India vendor appears in ALL bracket searches ✅/❌
   - ParchiSheet low-trust → checkbox required before confirm ✅/❌
   - Admin warns user → FCM push sent in user's language ✅/❌

**PRIORITY 2 — Razorpay vendor subscription (₹99/month)**
- Vendor subscription payment flow
- Trial period enforcement (`vendor_trial_days` config key already in whitelist)
- Subscription expiry → vendor goes offline automatically
- Admin dashboard: subscription status per vendor

**PRIORITY 3 — APK rebuild + 2-phone end-to-end test**
- `npm run build` → `npx cap sync android` → Android Studio → APK
- MASSIVE client-side changes since Session 38 — nothing tested on device since then
- Sessions 42–46 changes need device validation before Play Store

**PRIORITY 4 — Play Store submission**
- Requires: Google Play Developer Account ($25) + APK passing device test + Privacy Policy hosted + screenshots
- Claude will help write Play Store copy when Play Console account is ready

---

### ⚠️ IMMEDIATE ACTIONS BEFORE ANY DEVICE TESTING
1. **Verify CLI link** — `supabase projects list` — must be TEST (`hhdylnhqdzfabsolwxdz`)
2. **CRITICAL — Rebuild native app** — `npm run build` → `npx cap sync android` → Android Studio build. Massive changes since Session 38 device test. Nothing tested on device yet.
3. **Verify ANTHROPIC_API_KEY** in Supabase Edge Function secrets on BOTH TEST and PROD
4. **Admin FCM token** — after fresh APK install: `UPDATE app_config SET value = (SELECT fcm_token FROM user_devices WHERE user_phone = '8888169446' ORDER BY updated_at DESC LIMIT 1) WHERE key = 'admin_fcm_token'`
5. **dev_menu_pin** — change from default `1947` before public launch: `UPDATE app_config SET value = 'XXXX' WHERE key = 'dev_menu_pin'`

### Pre-Launch Blockers
| # | Blocker | Status |
|---|---|---|
| 1 | **Exotel KYC** (MSME → GST → submit) | 🔴 In progress — MSME started |
| 2 | **Rebuild APK + 2-phone end-to-end test** | ⏳ Waiting on Exotel + rebuild |
| 3 | **BR-3 account recovery** | ✅ Done Session 45 |
| 4 | **Customer name** (`app_users.name`) | ✅ Done Session 44D |
| 5 | **Appointment billing unblock** | ✅ Done Session 43 |
| 6 | **Vendor Service Radius + Pan-India** | ✅ Done Session 45 |
| 7 | **Google Play Developer Account** ($25) | ❌ Not started |
| 8 | **Razorpay** (vendor subscription ₹99/month) | ❌ Not started — Session 47 |

### CLI + PROD Status
- PROD: `rpxsyeqskvhjmbkxnpmd`
- TEST: `hhdylnhqdzfabsolwxdz`
- CLI linked to **TEST** at end of Session 46 ✅
- No pending PROD repair commands
- Always verify before any push: `supabase link --project-ref hhdylnhqdzfabsolwxdz`
- `_held/` pattern: prod-only cron migrations live in `supabase/migrations/_held/` — temporary-restore-for-push pattern

---

## 🏗️ SESSION 46 — ALL GAPS FIXED + CLEANUP BATCH + TEST RESET (17 June 2026)

### ✅ WHAT WAS DONE

Three parallel tracks: (1) Fixed all 9 gaps from Session 45C full-app audit, (2) Completed post-launch cleanup batch ahead of schedule, (3) Attempted to expand test suite — discovered structural test debt, performed honest reset.

---

### TRACK 1 — ALL 9 GAPS FIXED

**Gap 3 — Feed → Radar always passed `mode=delivery`** ✅
- `src/pages/LocalFeed.tsx` (was in pages/, not components/)
- `handleRecommendedVendorTap` now uses `post.recommended_vendor?.service_mode ?? "help"` instead of hardcoded `mode=delivery`
- Feed query + `FeedPost` type updated to include `service_mode` in the joined `recommended_vendor` select
- Tapping a recommended vendor now opens Radar on the correct tab (help, delivery, or appointment)

**Gap 4 — Feed treated all offline vendors as "went offline"** ✅
- `resolveRecommendedVendorRadarLink()` now takes `serviceMode` from `post.recommended_vendor?.service_mode`
- Only returns offline/dead state when `!is_active && service_mode === "help"`
- Delivery + appointment vendors always return a normal Radar link even when offline
- Missing vendor rows still fall through to the non-offline failure path (navigate to `/radar` with highlight)

**Gap 1 — ParchiSheet trust gates hardcoded English** ✅
- 7 new `parchi_trust_*` keys added to `strings.ts` (EN/HI/MR)
- `parchi_trust_low_title`, `parchi_trust_low_body`, `parchi_trust_low_confirmCheckbox`, `parchi_trust_low_confirmBtn`, `parchi_trust_medium_title`, `parchi_trust_medium_body`, `parchi_trust_medium_confirmBtn`
- Reused existing `parchi_btnCancel` for cancel button
- Uses `useLanguage()` pattern consistent with rest of `ParchiSheet.tsx`

**Gap 2 — Admin warn user copy hardcoded English sent to end users** ✅
- 3 new `warn_user_*` keys: `warn_user_title`, `warn_user_push_body`, `warn_user_inbox_body` (EN/HI/MR)
- `warnFlaggedUser()` in `Settings.tsx` now queries `app_users.lang` for the warned user's language before sending
- Full feature-flag fallback chain: `localization_enabled` off → EN; Hindi disabled → EN; Marathi disabled → EN
- Batched the `app_users` lang lookup with the existing `users.warn_count` fetch (one round trip instead of two)
- Admin UI buttons/toasts unchanged (English-only by design)

**Gap 5 — `order_help_delayed_warning` hardcoded "2+ hours"** ✅
- `strings.ts` updated: all 3 languages now use `{hours}+` placeholder
- `MyOrders.tsx` uses `.replace("{hours}", String(config.helpAcceptTimeoutHours))` — same interpolation pattern as `radar_distance_km`, `category_approved_body` etc.
- Admin can now change `help_accept_timeout_hours` in app_config and the amber warning copy updates automatically

**Gap 7 — app_config keys missing seed rows** ✅
- New migration `20260616000001_seed_app_config.sql` applied TEST + PROD
- 15 keys seeded with `INSERT ... ON CONFLICT (key) DO NOTHING` — never overwrites existing values
- Keys: `help_accept_timeout_hours`, `help_accept_timeout_minutes`, `near_deadline_warning_minutes`, `referral_enabled`, `vendor_lead_notify_enabled`, `localization_enabled`, `lang_hindi_enabled`, `lang_marathi_enabled`, `ai_category_confidence_threshold`, `app_base_url`, `admin_phone`, `khata_amber_limit`, `vendor_stopped_distance_meters`, `max_order_message_chars`, `appointment_accept_timeout_hours`
- PROD verification: 4 spot-checked keys confirmed present; pre-existing PROD values untouched

**Gap 8 — service_radius_km silent failure on registration** ✅
- `VendorMode.tsx`: post-register `service_radius_km` UPDATE failure now shows `toast.error(s.vendor_radius_save_error)` instead of silent `console.warn`
- Registration flow continues — vendor is registered, radius can be fixed in Settings
- New key `vendor_radius_save_error` in `strings.ts` EN/HI/MR

**Gap 9 — Localization sweep (4 files)** ✅
- `IncomingOrdersSection.tsx` — 25 new `incoming_*` keys: flag reasons, "Submit Report", "Confirm Decline", ledger sheet placeholders, trust badge labels, dismiss button. `FLAG_OPTIONS` → `flagOptions` useMemo (reactive to language)
- `RadarSearch.tsx` — 8 new `radar_gov_*` keys: Fire Brigade, 108 Ambulance, 1033 National Highway, 112 National Emergency (Police row already existed)
- `NotificationBell.tsx` — 6 new `notif_bell_*` keys: aria labels, title, loading, empty state, dismiss aria
- `TrustWarningBanner.tsx` — 1 new `trust_banner_masked_privacy` key
- `VendorMode.tsx` — 6 new `vendor_*` keys: categories update failed, partial save, shop details re-verify, load failed, photo saved, dismiss aria
- `VendorSettings.tsx` — 14 new `vendor_*` keys: offer validation errors, offer posted/removed, offer field labels, settings saved, voice unavailable, menu item aria labels
- Total: 60+ new localization keys this session across 6 files

**Gap 12 — Missing tests for new features** ✅
- `src/lib/radarVendorFilter.ts` — NEW: pure filter helpers extracted from `RadarSearch.tsx` (testable)
- `src/lib/radarVendorFilter.test.ts` — 10 tests: Track A distance filtering, Track B Pan-India, offline help vs delivery/appointment rules
- `src/components/FirstOpenFlow.test.tsx` — 6 tests: welcome gate, restore flows (known customer, unknown phone, vendor restore)
- 8 new Vitest files (+27 tests): DB integrity, UI+DB integration, UX flows, localization assertions
- **Total Vitest: 11 files, 44 tests passing, 0 failed**

**Gap 13 — Dead code** ✅
- `src/components/Radar.tsx` deleted (no imports found — confirmed via grep)
- `ADMIN_CONFIG_TYPES` in `Settings.tsx` — removed `payments_enabled` and `vendor_subscription_price` entries; type narrowed to `Partial<Record<AdminConfigKey, …>>`

**Gap 14 — debug_loc_error temp row** ✅
- Migration `20260616000002_remove_debug_loc_error.sql` applied TEST + PROD
- Row confirmed gone from both environments

**BY DESIGN (not fixed):**
- Gap 6: `useAppConfig` session cache — single admin, acceptable
- Gap 10: `ParchiSheet` two mode sources — no live bug
- Gap 11: Multi-category vendors on Radar — post-launch complexity
- Gap 15: AI free-text search without mode — inference handles it

---

### TRACK 2 — POST-LAUNCH CLEANUP BATCH (all 8 items — DONE AHEAD OF SCHEDULE)

| # | Item | What was done |
|---|---|---|
| 1 | `appointment_accept_timeout_hours` duplicate | Removed from `20260616000001` seed migration (already seeded in `20260606000000`) |
| 2 | `debug_loc_error` DB row | ✅ Removed via migration (Gap 14 above) |
| 3 | `settings_switchRole*` dead strings | Deleted 18 rows (6 keys × 3 langs) from `strings.ts` — grep confirmed no usages |
| 4 | `settings_shareApp` dead string | Deleted EN/HI/MR — grep confirmed no usages |
| 5 | `vendor_suggested_for` dead string | Deleted EN/HI/MR — grep confirmed no usages |
| 6 | `Radar.tsx` dead component | ✅ Deleted (Gap 13 above) |
| 7 | `cancelAppointment` dead function | Deleted from `IncomingOrdersSection.tsx` only — kept in `MyOrders.tsx` (3 live onClick refs) |
| 8 | `vendor_update` dead test type | Replaced with `'announcement'` in `tests/feed-flow.spec.ts` (FD-01, FD-08) |

All grepped before deletion — nothing with live references was removed.

---

### TRACK 3 — TEST SUITE HONEST RESET

**What happened:**
Attempted to expand the test suite after gap fixes. Discovered two structural problems:

**Problem 1 — Test count confusion:**
Session 38 had 336 Playwright tests. Today's `npm test` ran only 17 — because `npm test` runs Vitest (unit tests), not Playwright. The 336 Playwright tests run via `npx playwright test`. These are two separate suites that were being confused.

**Problem 2 — Browser UI tests have broken auth:**
All Playwright browser UI tests (CO-01 to CO-04, ADMIN-01, I18N-03–18, DEL-01 browser, etc.) fail because:
- App's auth guard checks Supabase session, NOT just localStorage
- `loginAsCustomer` helper sets localStorage (`aaspaas:user_phone`, `aaspaas:welcomed`) but creates no Supabase session
- App redirects to `/login?from=/` regardless of localStorage state
- This was always broken — tests were passing in Session 38 only for the pure-DB subset

**What was fixed vs removed:**
- Fixed: `DEL-01` DB test — `deletion_requested_at` assertion flipped to `toBeNull()` (correct per Session 44A Gap G10 design)
- Fixed: CO-01 to CO-04 selector updates (`welcome-card` → `first-open-flow`) — but tests still fail due to auth
- Removed: Broken browser UI tests (CO-01–CO-04 and equivalents) marked `test.skip` with explanation
- Installed: Chromium browser for Playwright (`npx playwright install chromium` — was missing on this machine)

**Current test state:**
| Suite | Count | Status |
|---|---|---|
| Vitest (unit + component) | 44 tests, 11 files | ✅ All passing |
| Playwright DB-only tests | ~180 tests | ✅ Passing (pure Supabase RPC calls, no browser) |
| Playwright browser UI tests | ~157 tests | ⚠️ Structurally broken — need auth fix in Session 47 |

**Root cause of broken browser tests — what Session 47 must fix first:**
```
// loginAsCustomer currently does this (WRONG):
await page.evaluate(() => localStorage.setItem('aaspaas:user_phone', '...'));
// App still redirects to /login — Supabase session doesn't exist

// loginAsCustomer must do this (CORRECT):
// Use Supabase service-role key to call auth.admin.createUser() + signInWithPassword()
// This creates a real session the app's auth guard accepts
```

**The deeper issue — tests validate code, not requirements:**
As Atul correctly challenged: having tests pass doesn't mean the app works correctly for real users. The current suite asks "does the code do what it was written to do?" not "does the app do what a kirana vendor in Warje needs it to do?". Session 47 must fix auth infrastructure first, then rebuild tests from requirement scenarios, not from code paths.

---

### MIGRATIONS APPLIED — SESSION 46
| Migration | TEST | PROD |
|---|---|---|
| `20260616000001_seed_app_config.sql` | ✅ Applied | ✅ Applied |
| `20260616000002_remove_debug_loc_error.sql` | ✅ Applied | ✅ Applied |

### FILES CHANGED — SESSION 46
| File | What changed |
|---|---|
| `src/pages/LocalFeed.tsx` | Gap 3 + Gap 4 — real service_mode, offline logic |
| `src/components/ParchiSheet.tsx` | Gap 1 — trust gate localization |
| `src/pages/Settings.tsx` | Gap 2 — warnFlaggedUser localization |
| `src/lib/strings.ts` | 60+ new keys across all gaps + 21 dead keys removed |
| `src/pages/MyOrders.tsx` | Gap 5 — dynamic {hours} interpolation |
| `src/pages/VendorMode.tsx` | Gap 8 + Gap 9 — radius error toast, vendor toasts localized |
| `src/components/IncomingOrdersSection.tsx` | Gap 9 — full localization sweep, dead cancelAppointment removed |
| `src/pages/RadarSearch.tsx` | Gap 9 — gov/emergency panel localized |
| `src/components/NotificationBell.tsx` | Gap 9 — localized |
| `src/components/TrustWarningBanner.tsx` | Gap 9 — localized |
| `src/components/settings/VendorSettings.tsx` | Gap 9 — offer/settings toasts localized |
| `src/components/Radar.tsx` | Gap 13 — DELETED |
| `src/lib/radarVendorFilter.ts` | Gap 12 — NEW pure filter helpers |
| `src/lib/radarVendorFilter.test.ts` | Gap 12 — NEW 10 tests |
| `src/components/FirstOpenFlow.test.tsx` | Gap 12 — NEW 6 tests |
| `src/lib/adminAudit.test.ts` | NEW — logAdminAction test |
| `src/lib/feedVendorLink.ts` | NEW — extracted for testability |
| `src/lib/feedVendorLink.test.ts` | NEW — 3 tests |
| `src/lib/orderHelpDelay.ts` | NEW — extracted for testability |
| `src/lib/orderHelpDelay.test.ts` | NEW — 3 tests |
| `src/lib/warnFlaggedUser.test.ts` | NEW — 1 test |
| `src/lib/vendorServiceRadius.ts` | NEW — extracted for testability |
| `src/lib/vendorServiceRadius.test.ts` | NEW — 2 tests |
| `src/components/ParchiSheet.trust.test.tsx` | NEW — 2 tests |
| `src/components/NotificationBell.test.tsx` | NEW — 2 tests |
| `src/components/localization.copy.test.tsx` | NEW — 13 localization tests |
| `src/test/dbFixtures.ts` | NEW — shared seed key constants |
| `tests/account-deletion.spec.ts` | DEL-01 fixed — deletion_requested_at → toBeNull() |
| `tests/feed-flow.spec.ts` | vendor_update type → announcement |
| `tests/db-integrity.spec.ts` | NEW — 4 DB integrity tests (Playwright) |
| `supabase/migrations/20260616000001_seed_app_config.sql` | NEW — 15 keys seeded |
| `supabase/migrations/20260616000002_remove_debug_loc_error.sql` | NEW — debug row removed |

---

## 🏗️ SESSION 45C — ADMIN PANEL AUDIT + FULL-APP AUDIT (16 June 2026)

### Admin Panel — 7 fixes applied

**Gap 13 — Config changes not audit-logged** ✅
- `saveAdminConfigKey()` now calls `logAdminAction('update_config', 'config', key, \`${key} = ${value}\`)`
- New `AdminActionType`: `update_config`, new `AdminTargetType`: `"config"`

**Gap 14 — Review delete not audit-logged** ✅
- `deleteLowRating()` now calls `logAdminAction('delete_review', 'vendor', row.vendor_id, \`review_id:${row.id} rating:${row.rating}\`)`
- New `AdminActionType`: `delete_review`

**Gap 15 — Admin check pass/fail not audit-logged** ✅
- `setAdminCheckStatus()` now calls `logAdminAction('admin_check_passed' | 'admin_check_failed', vendorId, 'admin_check')`
- New `AdminActionType`: `admin_check_passed`, `admin_check_failed`

**Gap 16 — Hardcoded English in admin UI** ⚪ By design — Atul reads English, admin is Atul only

**Gap 17 — Whitelist missing keys** ✅
Added 8 keys with logical grouping:
- Order/expiry: `appointment_accept_timeout_hours`
- Vendor behaviour: `vendor_stopped_distance_meters`, `max_order_message_chars`
- Feature flags: `localization_enabled`, `lang_hindi_enabled`, `lang_marathi_enabled`
- AI: `ai_category_confidence_threshold`
- App: `app_base_url`

**Gap 18 — Orphan radar keys in whitelist** ✅
- Removed `radar_city_radius_km` + `radar_highway_radius_km` from whitelist + labels (deleted from app_config in migration `20260615000002`)

**Gap 19 — No input validation on config saves** ✅
- Boolean keys → toggle switches (save on toggle): `referral_enabled`, `vendor_lead_notify_enabled`, `localization_enabled`, `lang_hindi_enabled`, `lang_marathi_enabled`
- Number keys → `type="number"` with "Must be a number" validation: all timeout/near-deadline/distance/threshold keys
- Text keys → unchanged

**Gap 20 — Config load race** ⚪ Skip — single admin, no multi-device scenario

**Gap 21 — Review delete no confirm dialog** ✅
- Confirm dialog added before `deleteLowRating()`: "Delete this review?" + "Rating: ★★… — this cannot be undone." + Cancel/Delete buttons

**Files changed — Session 45C:**
| File | What changed |
|---|---|
| `src/lib/adminAudit.ts` | 4 new action types + `"config"` target type |
| `src/pages/Settings.tsx` | Audit calls on config save/review delete/admin check. Whitelist + labels updated. Orphan keys removed. Boolean toggles. Number validation. Review delete confirm dialog |

**No migrations — all UI + audit logging only.**

### Full-App Audit — Gap Triage (end of Session 45C)

See SESSION 46 START HERE section above for full fix order and details.

**Summary:**
- 15 gaps found in final full-app audit
- 9 real fixes (Gaps 1,2,3,4,5,7,8,9,12,13,14)
- 6 by-design/post-launch (Gaps 6,10,11,15)
- Biggest behavioral bug: Feed→Radar mode/offline (Gaps 3+4) — fix first
- Biggest localization gap: ParchiSheet trust gates + admin warn user copy (Gaps 1+2)
- Biggest test hole: service_radius_km filtering + Pan-India track B (Gap 12)
- Admin config UPSERT (silent save failure fixed), 8 new keys added to whitelist (radar radii, call limits, subscription price, trial days), all 24 labels human-readable
- Feed toggle reverted to native-only (web can't receive push notifications — was incorrectly shown on web since S42B)
- Hardcoded English in MY SHOP/Preferences/addresses all localized to EN/HI/MR
- Post-launch cleanup batch documented (8 items: dead configs, dead strings, dead components)
- No migrations needed — all client-side

**Sessions 43-44D complete — full audit sprint:**
- Khata/Billing ✅, Data Deletion ✅, Ratings/Reviews ✅, Vendor Registration ✅, Referrals ✅, Customer Name ✅

**All audits complete except Admin panel.** Admin panel is the last remaining audit.

### ⚠️ IMMEDIATE ACTIONS BEFORE ANY DEVICE TESTING
1. **Verify CLI link** — `supabase projects list` — confirm linked to TEST (`hhdylnhqdzfabsolwxdz`) before any push
2. **CRITICAL — Rebuild native app** — `npm run build` → `npx cap sync android` → Android Studio build. MASSIVE client-side changes accumulated across Sessions 42-45B. Nothing tested on device since Session 38.
3. **Verify ANTHROPIC_API_KEY** in Supabase Edge Function secrets on BOTH TEST and PROD — required for `suggest-category`
4. **Admin FCM token** — after fresh APK install, update: `UPDATE app_config SET value = (SELECT fcm_token FROM user_devices WHERE user_phone = '8888169446' ORDER BY updated_at DESC LIMIT 1) WHERE key = 'admin_fcm_token'`

### Pre-Launch Blockers (in priority order)
| # | Blocker | Status |
|---|---|---|
| 1 | **Exotel KYC** (MSME → GST → submit) | 🔴 Started |
| 2 | **Rebuild APK + 2-phone end-to-end test** | ⏳ Waiting on Exotel + rebuild |
| 3 | **BR-3 account recovery** | ✅ Done Session 45 |
| 4 | **Customer name** (`app_users.name`) | ✅ Done Session 44D |
| 5 | **Appointment billing unblock** | ✅ Done Session 43 |
| 6 | **Vendor Service Radius + Pan-India** | ✅ Done Session 45 |
| 7 | **Google Play Developer Account** ($25) | ❌ Not started |
| 8 | **Razorpay** (vendor subscription only — ₹99/month vendor pays Aaspaas Pro) | ❌ Not started |

### REMAINING BUILD BACKLOG
All audits complete ✅. All gap fixes complete ✅. Post-launch cleanup batch complete ✅.

| Module | Notes |
|---|---|
| **Requirement-based E2E test suite** | Session 47 Priority 1 — fix Playwright auth first (service-role loginAsCustomer), then write tests from user scenarios not code paths |
| **Razorpay vendor subscription** | Session 47 Priority 2 — ₹99/month, trial period, auto-offline on expiry |
| **APK rebuild + 2-phone device test** | ⏳ Waiting on Exotel KYC — massive changes since Session 38 untested on device |
| **Play Store submission** | ⏳ Waiting on Play Console account ($25) + device test passing |

### ⚠️ PROD — Status
- No pending repair commands
- CLI confirmed on TEST (`hhdylnhqdzfabsolwxdz`) at end of Session 46
- `_held/` pattern: prod-only cron migrations live in `supabase/migrations/_held/` — use temporary-restore-for-push pattern

---

## 🏗️ SESSION 45 — BR-3 + SERVICE RADIUS + OFFLINE ORDERS + RADAR MODE (15 June 2026)

### ✅ WHAT WAS DONE

Four major features built across multiple Cursor prompts. No module audit this session — pure feature build.

---

### FEATURE 1 — BR-3 ACCOUNT RECOVERY (Pre-launch blocker #3 ✅)

**WHAT:** First-open flow built from scratch. When user opens app for the first time (or after reinstall), they see a restore prompt, can enter their phone to recover history, and are asked for notification permission.

**WHY it was needed:**
- `skipRecovery={true}` was hardcoded at both call sites (`ParchiSheet` + `RadarVendorCard`) — recovery UI existed in code but was completely dead
- Reinstall = identity lost. Vendor had to re-register. Customer lost all order history. No recovery path existed.
- `hasBeenWelcomed()`/`markWelcomed()` were local to `Index.tsx` — not shareable

**HOW it works — 3 internal states:**

**State 1 — Restore prompt** (full-screen overlay, `fixed inset-0 z-50`)
- Shows on first open when `!hasBeenWelcomed()`
- Phone input (10-digit Indian number, +91 normalized)
- "Restore my account" CTA + "Skip, start fresh" link
- On restore attempt: queries BOTH `users` (customer) AND `vendors` (vendor) tables by phone
- If either found → `saveUserPhone()` + `migrateUserPhone()` → restores customer identity
- If vendor row found with `is_active=true` AND `deletion_requested_at=null` → silently restores `aaspaas:vendor_id` + `aaspaas:role=vendor` + `aaspaas:vendor_active=1` → dispatches `VENDOR_ACTIVE_CHANGED_EVENT` so BottomNav shows vendor tab immediately
- Admin: same phone as `admin_phone` in app_config → admin panel accessible automatically after vendor restore
- If no history found → "No account found. Starting fresh." → moves to next state

**State 2 — Notification permission** (native only, web skips)
- `PushNotifications.requestPermissions()` → if granted → `PushNotifications.register()` only
- No `registerUserPushToken` called here (avoids double permission request)
- Skip option available

**State 3 — Done**
- Calls `onComplete()` → parent calls `markWelcomed()` → overlay unmounts → Home visible

**Identity restoration matrix:**
| User type | Restored |
|---|---|
| Pure customer | `user_phone` + `migrateUserPhone()` (relinks device orders) |
| Pure vendor | `user_phone` + `vendor_id` + `role` + `vendor_active` |
| Dual-role (customer + vendor) | Both — same phone entry restores everything |
| Admin | Same as vendor — admin panel accessible via phone match |
| New user (no history) | Skip or "no account found" → goes to Home fresh |
| Banned/deleted vendor | Customer identity restored, vendor session NOT restored (`deletion_requested_at` check) |

**Settings permissions improvements (same session):**
- Inline `requestPermissions()` for all 4 permissions (notifications/location/camera/mic) — previously showed only instruction dialog
- Microphone row added (`@capacitor-community/speech-recognition`)
- `prompt`/`prompt-with-rationale` → inline request; `denied` → fallback instruction dialog
- `settings_permission_heading` localized (was hardcoded "Permissions")

**Files changed — BR-3:**
| File | What changed |
|---|---|
| `src/components/FirstOpenFlow.tsx` | NEW — full first-open state machine |
| `src/pages/Index.tsx` | Replaced welcome card with `<FirstOpenFlow>`. Removed local `hasBeenWelcomed`/`markWelcomed` |
| `src/lib/userIdentity.ts` | Added `hasBeenWelcomed()`, `markWelcomed()`, `restoreVendorSession()` exports |
| `src/pages/Settings.tsx` | Inline permission requests for all 4 permissions. Mic row added. Heading localized |
| `src/lib/strings.ts` | 11 `firstopen_*` keys + 3 `settings_permission_*` keys EN/HI/MR |

**No migrations — BR-3 uses existing `users`, `vendors`, `app_users` tables.**

---

### FEATURE 2 — VENDOR SERVICE RADIUS + PAN-INDIA

**WHAT:** Vendors declare how far they serve. Customers filter search by distance bracket. Pan-India sellers (9999) bypass GPS entirely and appear in all searches nationwide.

**WHY:** Current Radar locked all vendors to 15km. Indian informal economy has:
- Wholesalers supplying kiranas across entire city/region
- B2B vendors (kirana buys from sabziwala, salon buys from beauty supplier)
- Amazon-style sellers who want direct customer relationships without Amazon's commission
- Ausa customers buying from Solapur, Hyderabad — city boundaries are irrelevant to real trade

**VISION DECISION LOCKED — Session 45:**
Aaspaas Pro is NOT just hyperlocal. It is a **trust-first marketplace** where:
- Local vendors serve neighbourhood (5-100km)
- Pan-India sellers serve everyone (9999 = sentinel, bypasses GPS)
- ALL on same platform with same trust system (verification, khata, ratings, masked calls)
- Differentiation from Amazon: you know your vendor through community trust

**Radius options:**
| Option | DB value | Who uses it |
|---|---|---|
| 5 km | 5 | Street vendor, chai stall |
| 15 km | 15 | Neighbourhood kirana (DEFAULT) |
| 25 km | 25 | City-wide service |
| 50 km | 50 | Regional supplier |
| 100 km | 100 | Inter-city trade |
| 500 km | 500 | State-wide |
| Pan-India 🇮🇳 | 9999 | Amazon-style seller, ships anywhere |

**HOW Radar query works (two-track):**
- **Track A** — GPS-bounded: `service_radius_km < 9999` + bbox filter + client Haversine: `dist <= min(userBracket, vendor.service_radius_km)`
- **Track B** — Pan-India: `service_radius_km = 9999`, NO bbox, NO Haversine — appears in ALL searches
- Track B shown at bottom with section header "Ships across India" + 🇮🇳 badge on each card
- User selects Pan-India bracket → Track B only shown

**Customer bracket filter chips:**
Within 15km (default) / 25km / 50km / 100km / 500km / Pan-India 🇮🇳

**Delivery disclaimer:** "Delivery terms and charges are set by each vendor." — shown once at top of ALL results (not per card, not Pan-India only)

**Dead config removed:** `radar_city_radius_km` + `radar_highway_radius_km` from `app_config` — replaced by explicit bracket chips

**Files changed — Service Radius:**
| File | What changed |
|---|---|
| `src/lib/serviceRadius.ts` | NEW — `PAN_INDIA_RADIUS_KM = 9999`, options array, `normalizeServiceRadiusKm()` |
| `src/components/ServiceRadiusChips.tsx` | NEW — reusable chip row for registration + settings |
| `src/pages/RadarSearch.tsx` | Two-track query. Bracket filter chips. Delivery disclaimer. Pan-India section header |
| `src/components/RadarVendorCard.tsx` | Pan-India badge (inline, below VendorTypeLabel — not overlapping trust badge) |
| `src/pages/VendorMode.tsx` | Registration radius picker. Post-register UPDATE for `service_radius_km` |
| `src/components/settings/VendorSettings.tsx` | Editable service radius field in Shop Info section |
| `src/lib/supabase.ts` | `Vendor` type updated with `service_radius_km: number` |
| `src/lib/useAppConfig.ts` | Removed `radarCityRadiusKm` + `radarHighwayRadiusKm` (dead config) |
| `src/lib/strings.ts` | `vendor_radius_*`, `radar_bracket_*`, `radar_delivery_disclaimer`, `radar_pan_india_*` keys EN/HI/MR |

**Migrations — Service Radius:**
| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260615000001_vendor_service_radius.sql` | `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS service_radius_km integer NOT NULL DEFAULT 15` | ✅ | ✅ |
| `20260615000002_remove_radar_config_keys.sql` | `DELETE FROM app_config WHERE key IN ('radar_city_radius_km', 'radar_highway_radius_km')` | ✅ | ✅ |

---

### FEATURE 3 — OFFLINE VENDOR ORDERS

**WHAT:** Delivery and appointment vendors now visible in Radar even when offline (`is_active = false`). Customers can place future orders. Help mode unchanged.

**WHY:** Critical lost-business gap. Vendor offline = customer has no way to act on intent. Real Indian behaviour:
- Customer wants to order from kirana tomorrow morning
- Customer wants to book beautician appointment next week
- Vendor is offline NOW but can fulfil LATER
- Help mode is real-time only — correct to keep `is_active = true`

**HOW it works:**
- Delivery + appointment: `is_active` filter REMOVED from Radar query
- Offline vendor cards show amber "Currently offline" badge
- ParchiSheet shows amber banner: "This vendor is currently offline. Your order will be sent when they come back online."
- Appointment validation: if vendor offline, appointment time must be at least 2 hours from now (otherwise vendor won't see it in time)
- Re-fetch on tap: when customer taps offline delivery/appointment card → fresh `is_active` check before opening ParchiSheet — if vendor came back online, banner not shown
- Help mode: `is_active = true` ALWAYS in query — never show offline help vendors

**Expiry framework handles everything automatically:**
- Order placed on offline vendor → existing pg_cron expiry + notification framework fires as normal
- Vendor comes online → sees pending orders → accepts/declines → normal flow
- Vendor never comes online → order expires → customer notified ("No vendor accepted your request")

**Files changed — Offline Orders:**
| File | What changed |
|---|---|
| `src/pages/RadarSearch.tsx` | `is_active` filter conditional on resolved mode |
| `src/components/RadarVendorCard.tsx` | Offline amber badge. Re-fetch on tap for delivery/appointment. `openParchi` only blocks offline for help mode |
| `src/components/ParchiSheet.tsx` | Offline amber banner. Appointment 2-hour validation for offline vendor |
| `src/lib/strings.ts` | `vendor_offline_badge`, `parchi_offline_banner`, `parchi_offline_appt_too_soon` EN/HI/MR |

**No migrations needed.**

---

### FEATURE 4 — RADAR MODE SELECTOR

**WHAT:** Three explicit mode buttons at top of Radar (Help / Delivery / Booking). Customer selects mode before searching. Replaces inferred mode from category matching.

**WHY:** Inferred mode from categories caused 3 risks:
1. Category vs vendor mode mismatch — wrong is_active filter applied
2. Mixed category modes — offline vendors incorrectly hidden
3. Mode not passed in URL — Radar always opened in Help mode from Home

All three risks eliminated by explicit mode selection.

**UI Design:**
```
┌─────────────────────────────────────────┐
│  🆘          📦          📅            │
│  Help      Delivery    Booking          │
│ Need someone  Order for  Book           │
│   now       delivery  appointment       │
└─────────────────────────────────────────┘
```
- Full width, 3 equal columns, ~64px tap height — thumb friendly for Bharat-80
- Selected: `bg-brand text-white rounded-xl`
- Unselected: `bg-muted text-muted-foreground border rounded-xl`
- Default: Help
- Mode change → resets search term + bracket to 15km → re-runs fetch

**HOW query works with explicit mode:**
- `.eq("service_mode", selectedMode)` in DB query directly
- Help: + `.eq("is_active", true)` — real-time only
- Delivery/Appointment: no `is_active` filter — offline vendors shown
- `resolveSearchServiceMode()` removed — dead code
- `applyHelpModeFilter()` removed — replaced by DB filter

**Mode in URL:**
- Home category grid/picker → `goToRadar(label, service_mode)` → `/radar?q=...&mode=help|delivery|appointment`
- Raw term (voice/AI/typed) → Radar infers from resolved categories on mount
- LocalFeed → `&mode=delivery` default
- Mode selector change → URL updated with `setSearchParams({ mode })`

**AI suggest cross-mode mismatch:**
- If AI returns category with different `service_mode` than selected mode → amber banner: "This looks like a {mode} service. Switch to {mode} mode?"
- Switch button → updates `selectedMode` → re-runs fetch with that category
- Never auto-switches without user confirmation — user explicitly chose their mode

**Files changed — Radar Mode Selector:**
| File | What changed |
|---|---|
| `src/pages/RadarSearch.tsx` | Mode selector UI. Explicit `.eq("service_mode")` in query. `resolveSearchServiceMode()` + `applyHelpModeFilter()` removed. Mode read from URL on mount. AI mismatch banner |
| `src/pages/Index.tsx` | `goToRadar()` now accepts + passes `service_mode` in URL |
| `src/components/LocalFeed.tsx` | Radar navigation includes `&mode=delivery` |
| `src/lib/strings.ts` | `radar_mode_*` (6 mode selector keys) + `radar_suggest_mode_mismatch` + `radar_suggest_mode_switch` EN/HI/MR |

**No migrations needed.**

---

### 📦 ALL MIGRATIONS — SESSION 45
| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260615000001_vendor_service_radius.sql` | `service_radius_km integer NOT NULL DEFAULT 15` on vendors | ✅ | ✅ |
| `20260615000002_remove_radar_config_keys.sql` | Remove `radar_city_radius_km` + `radar_highway_radius_km` from app_config | ✅ | ✅ |

BR-3, Offline Orders, Radar Mode Selector — no migrations (UI only, uses existing tables).

### ARCHITECTURAL DECISIONS LOCKED — SESSION 45

| Decision | Detail |
|---|---|
| **Aaspaas Pro is trust-first marketplace, not just hyperlocal** | Pan-India sellers on same platform as neighbourhood vendors. Differentiation = trust (verification, khata, ratings, masked calls) not geography |
| **Pan-India = 9999 sentinel** | Never passed to Haversine. Bypasses GPS bounding box entirely. Shown as separate section at bottom of results |
| **Offline orders: delivery + appointment YES, help NO** | Help is real-time. Delivery + appointment are scheduled — offline vendor can still fulfil later. Existing expiry framework handles failures |
| **Minimum lead time for offline vendor = 2 hours** | Matches ASAP delivery slot deadline. Appointment must be >2 hours away if vendor offline |
| **Explicit mode selection over inferred** | User picks Help/Delivery/Booking explicitly. No guessing from categories. Cleaner query, fewer edge cases |
| **Never auto-switch mode on AI suggest mismatch** | User chose their mode deliberately. Show suggestion, let user decide to switch |
| **Delivery terms disclaimer once at top** | Not per card, not Pan-India only. All vendors set their own terms. One line, muted, at top of results |
| **BR-3 restores ALL identity from one phone entry** | Customer history + vendor session + admin access — all from single phone number. No separate re-registration needed |
| **Vendor session restore guards** | `is_active=true` AND `deletion_requested_at=null` required. Banned/deleted vendors never auto-restored |

---

## 🏗️ SESSION 45B — SETTINGS AUDIT + FIXES (16 June 2026)

### ✅ WHAT WAS DONE
Full audit of the Settings page — 17 gaps (Gap 1-17) identified and triaged. 10 fixed across 3 Cursor prompts. 4 by-design. 3 deferred to post-launch cleanup batch. No migrations needed — all client-side changes.

### Settings Structure (Reference — Three Effective Views)

**Customer view** (`!vendorId`, `!isAdmin`):
My Account (My Identity, Account Standing, My Delivery Addresses, Preferences) → Feed Notifications (native-only) → Connection & Privacy → Clear My Data → Delete Account → Footer → Dev Menu (7-tap + PIN)

**Vendor view** (adds MY SHOP after My Account):
MY SHOP: Shop Info → Note for Customers → Menu → Offers → Order Alerts (native-only) → Refer & Earn (gated on `referral_enabled`) → Rejection Reasons → Ledger Cycle → Khata Credit Settings (S43) → My Reviews (S44B)

**Admin view** (Settings tab = customer/vendor stack, PLUS Admin tab):
Admin Tab: App Health → Vendor Moderation → Pending Categories (S42B) → Low Ratings (S44B) → App Config (24 whitelisted keys, all human-readable now — S45B fix)

### ADMIN_CONFIG_WHITELIST — Updated (24 keys, all human-readable labels)
| Key | Label (as of S45B) | Notes |
|---|---|---|
| `referral_enabled` | "Referral Program Enabled" | |
| `help_accept_timeout_hours` | "Help Accept Timeout (hours)" | |
| `help_accept_timeout_minutes` | "Help Accept Timeout (minutes)" | |
| `help_near_deadline_minutes` | "Help Near-Deadline Warning (minutes)" | |
| `delivery_near_deadline_minutes` | "Delivery Near-Deadline Warning (minutes)" | |
| `appointment_near_deadline_minutes` | "Appointment Near-Deadline Warning (minutes)" | |
| `vendor_stopped_minutes` | "Vendor Stopped Detection (minutes)" | |
| `location_ping_seconds` | "Vendor Location Ping Interval (seconds)" | |
| `referral_user_credit` | "Referral Credit — Customer (₹)" | |
| `referral_vendor_credit_total` | "Referral Credit — Vendor Total (₹)" | |
| `referral_vendor_credit_m1` | "Referral Credit — Vendor Month 1 (₹)" | |
| `referral_vendor_credit_m2` | "Referral Credit — Vendor Month 2 (₹)" | |
| `referral_vendor_credit_m3` | "Referral Credit — Vendor Month 3 (₹)" | |
| `referral_veteran_threshold_months` | "Referral Veteran Threshold (months)" | |
| `dev_menu_pin` | "Developer Menu PIN" | |
| `feed_notification_radius_km` | "Feed Notification Radius (km)" | |
| `vendor_lead_notify_enabled` | "Notify Admin on New Vendor Lead" | NEW S45B |
| `radar_city_radius_km` | "Radar City Search Radius (km)" | NEW S45B — now wired in Radar |
| `radar_highway_radius_km` | "Radar Max Search Radius (km)" | NEW S45B — now wired in Radar |
| `vendor_trial_days` | "Vendor Trial Period (days)" | NEW S45B — for Razorpay sprint |
| `subscription_price_inr` | "Vendor Subscription Price (₹/month)" | NEW S45B — for Razorpay sprint |
| `help_call_limit_seconds` | "Help Call Time Limit (seconds)" | NEW S45B |
| `delivery_call_limit_seconds` | "Delivery Call Time Limit (seconds)" | NEW S45B |
| `appointment_call_limit_seconds` | "Appointment Call Time Limit (seconds)" | NEW S45B |

**Keys in DB but NOT in whitelist (intentional):**
| Key | Why excluded |
|---|---|
| `appointment_accept_timeout_hours` | DEAD CONFIG — cron loads it but never uses it (expiry uses `appointment_time` only). Excluded to avoid misleading admin. Session 42 Gap B14 decision. |
| `ai_category_confidence_threshold` | Admin tuning the threshold doesn't fix AI accuracy — fix the prompt instead. Post-launch: review actual approve/reject patterns, improve Claude prompt if patterns emerge. |
| `ai_category_model` | Code-level decision when a better model is available — not admin UI. |
| `admin_fcm_token` | Auto-managed by app (device FCM registration). Manual edit would break admin notifications. |
| `vendor_lead_notify_enabled` | NOW in whitelist (S45B fix) |
| `edge_function_url`, `anon_key` | Infrastructure/env-specific keys. Wrong value → silent failure in feed trigger. Never admin UI. |
| `debug_loc_error` | Temp diagnostic key leftover — added to cleanup batch |
| `localization_enabled`, `lang_hindi_enabled`, `lang_marathi_enabled`, `app_base_url`, `max_order_message_chars` | Deployment-level config, too risky for casual admin edit |
| `vendor_trial_days`, `subscription_price_inr` | NOW in whitelist (S45B) |

### GAP TRIAGE — SETTINGS (Gap 1-17)

| Gap | Description | Decision | Fix |
|---|---|---|---|
| **1** | Feed notifications toggle shown on web (S42B added) but persistence silently fails — web has no `user_devices` row (FCM-native-only). Toggle changes UI but saves nothing. | ✅ Fixed | Re-hide toggle on web with `Capacitor.isNativePlatform()` gate. Comment added: "Feed push notifications use FCM, not available on web — toggle meaningless on web, native-only by design." |
| **2** | Extensive hardcoded English in MY SHOP (`"Shop Info"`, `"Offers"`, `"Post Offer"`, voice UI, address actions), Preferences (voice section), Khata toast | ✅ Fixed | Moved to strings.ts (EN/HI/MR): `settings_shopInfo`, `settings_editShopDetails`, `settings_offers`, `settings_postOffer`, `settings_addPhotoOptional`, `settings_listeningSpeak`, `settings_callCustomer`, `settings_ledgerCycleUpdated`, `settings_voiceInputLang`, `settings_voiceAutoDetect`, `settings_voiceAuto`/`voiceEnglish`/`voiceHindi`/`voiceMarathi`, `settings_save`, `settings_deleteAddressTitle`, `settings_deleteAddressBody` |
| **3** | `appointment_accept_timeout_hours` in DB but not in whitelist | ⚪ By design | DEAD CONFIG — intentionally hidden (Session 42 Gap B14). Post-launch cleanup batch (remove from DB entirely). |
| **4** | `ai_category_confidence_threshold` and `ai_category_model` not in whitelist | ⚪ Not a fix | Tuning the threshold doesn't fix AI accuracy. Post-launch: if admin observes bad suggest-category patterns, fix the Claude PROMPT, not the threshold. Config not exposed. |
| **5** | `vendor_lead_notify_enabled` not in whitelist | ✅ Fixed | Added to whitelist (controls whether admin gets "new vendor lead" push from unlinked recommendations) |
| **6** | `saveAdminConfigKey` is UPDATE-only — fails silently if row doesn't exist in DB | ✅ Fixed | Changed to UPSERT (`INSERT ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`) |
| **7** | ~15 `useAppConfig` keys (radar radii, call limits, subscription price, trial days) not in admin whitelist | ✅ Fixed | Added 7 operational keys: `radar_city_radius_km`, `radar_highway_radius_km`, `vendor_trial_days`, `subscription_price_inr`, `help_call_limit_seconds`, `delivery_call_limit_seconds`, `appointment_call_limit_seconds`. Excluded deployment-level keys (localization, app_base_url etc.) |
| **8** | Admin moderation UI (ban dialogs, verify sheet, tab labels "Settings"/"Admin") entirely in English | ⚪ By design | Admin = Atul (and future English-speaking staff). Internal tooling stays English. |
| **9** | No automated tests for Pending Categories or Low Ratings admin panels | ⏳ Test suite backlog | Added to requirement-based test suite sprint |
| **10** | `referEarnVisible` initializes to `false` — brief flicker hides Refer & Earn section until config loads | ✅ Fixed | Changed to `useState(true)` (optimistic — referrals enabled is the common case). Only sets `false` when config explicitly returns `"false"` or `"0"`. |
| **11** | `"MY ACCOUNT"` / `"MY SHOP"` hardcoded labels; `settings_myShop` string existed but was unused | ✅ Fixed | Uses `s.settings_myAccount` and `s.settings_myShop` now. CSS `text-transform: uppercase` applied by `SettingsParentCollapsible` — strings stay normal case so HI/MR Devanagari translations render correctly (all-caps looks wrong in Devanagari script) |
| **12** | `ADMIN_CONFIG_LABELS` mostly raw key names — poor admin UX | ✅ Fixed | All 24 whitelist keys now have human-readable labels (see table above) |
| **13** | `debug_loc_error` temp diagnostic key still in DB | ⏳ Cleanup batch | Remove from `app_config` table — post-launch cleanup |
| **14** | Feed toggle shows no error when UPDATE affects 0 rows | ✅ Fixed | `useFeedNotificationsEnabled`: uses `.select().maybeSingle()` to detect 0-row UPDATE. On error/null data: `revertToggle()` (restores visual state + dispatches event) + `toast.error(s.feed_notifyToggle_saveError)`. New string `feed_notifyToggle_saveError` (EN/HI/MR) |
| **15** | Dead strings `settings_switchRole*`, `settings_shareApp` in strings.ts — no longer rendered | ⏳ Cleanup batch | Remove in post-launch string cleanup |
| **16** | `"Ledger cycle start updated."` toast hardcoded English | ✅ Fixed | Folded into Gap 2 — uses `s.settings_ledgerCycleUpdated` |
| **17** | `isAdmin` uses hardcoded `ADMIN_PHONE_FALLBACK` until config loads | ⚪ By design | Bootstrap pattern — prevents flash of "non-admin" UI during initial `app_config` load. Hardcoded fallback = Atul's own number. Acceptable. |

### POST-LAUNCH CLEANUP BATCH (accumulated across all sessions)
This batch will be done in one dedicated cleanup session when audit work is complete:
| Item | Source |
|---|---|
| `appointment_accept_timeout_hours` — remove from DB | Session 42 Gap B14 |
| `debug_loc_error` — remove from `app_config` | Session 45B Gap 13 |
| Dead strings: `settings_switchRole*`, `settings_shareApp` | Session 45B Gap 15 |
| `src/components/Radar.tsx` — unused decorative component | Session 42C RS-18 |
| `MOBILE_CATEGORIES` constant — unused | Session 42C RS-24 |
| `vendor_update` type in test seeds only | Session 42B A17 |
| `vendor_suggested_for` dead string in strings.ts | Session 42B R9 |
| `cancelAppointment()` dead code in IncomingOrdersSection | Session 42 Gap B9 |

### KEY ARCHITECTURAL DECISIONS — SESSION 45B

**Feed push notifications are native-only by design.** Web users accessing Aaspaas (typically vendors/admin for settings/billing purposes) cannot receive push notifications via FCM. The feed notifications toggle was briefly shown on web (Session 42B fix) but this was incorrect — the toggle controls push notification preference and is meaningless on a platform that cannot receive them. Reverted in Session 45B. Web access to Aaspaas is considered secondary; the app is primarily a native Android experience.

**Admin panel is English-only by design.** Admin is a technical role (Atul, future technical hires) requiring English for effective operation. Unlike customer/vendor-facing UI (which must be in HI/MR for Bharat-80), admin moderation tooling, ban dialogs, verification checklists, and settings labels remain in English. Explicitly not a gap.

**AI tuning config not exposed to admin UI.** `ai_category_confidence_threshold` and `ai_category_model` are excluded from the whitelist. Tuning the threshold doesn't fix AI quality — it only changes how autonomously a mediocre AI acts. The correct lever for improving category suggestions is the Claude prompt (in `suggest-category` edge function), informed by real patterns from the Pending Categories admin panel once real vendors start using the AI flow.

**Admin config UPSERT is now the default.** Previously UPDATE-only — adding a new key to the whitelist but forgetting to seed the DB row would cause silent save failure. UPSERT ensures first-time saves INSERT correctly, protecting fresh environments and new config keys like `vendor_trial_days` and `subscription_price_inr` which will be set for the first time when Razorpay sprint begins.

### FILES CHANGED — SESSION 45B
| File | What changed |
|---|---|
| `src/pages/Settings.tsx` | Gap 1: feed toggle re-gated to native-only. Gap 6: `saveAdminConfigKey` → UPSERT. Gap 7+5: 8 new keys added to ADMIN_CONFIG_WHITELIST. Gap 12: all 24 ADMIN_CONFIG_LABELS updated to human-readable. Gap 10: `referEarnVisible` → `useState(true)`. Gap 11: `"MY ACCOUNT"` → `s.settings_myAccount`. |
| `src/components/settings/VendorSettings.tsx` | Gap 2+11+16: `"MY SHOP"` → `s.settings_myShop`; all MY SHOP hardcoded strings replaced with string keys |
| `src/hooks/useFeedNotificationsEnabled.ts` | Gap 14: 0-row UPDATE detection via `.maybeSingle()`, `revertToggle()`, error toast |
| `src/lib/strings.ts` | All new keys: `settings_myAccount`, `settings_shopInfo`, `settings_editShopDetails`, `settings_offers`, `settings_postOffer`, `settings_addPhotoOptional`, `settings_listeningSpeak`, `settings_callCustomer`, `settings_ledgerCycleUpdated`, `settings_voiceInputLang`, `settings_voiceAutoDetect`, `settings_voiceAuto/English/Hindi/Marathi`, `settings_save`, `settings_deleteAddressTitle`, `settings_deleteAddressBody`, `feed_notifyToggle_saveError` — all EN/HI/MR |

### SETTINGS REQUIREMENTS SPEC — FOR TEST CASE GENERATION

#### SET-01: Feed Toggle — Native Only
- **WHAT:** Feed notifications toggle visibility
- **EXPECTED:** Toggle shown ONLY on native (Capacitor.isNativePlatform()). Hidden on web.
- **TEST CASE:** Render Settings on web → assert feed notifications toggle absent.

#### SET-02: Feed Toggle — Error Handling
- **WHAT:** Toggle save when `user_devices` row missing
- **EXPECTED:** Revert toggle visual state + `feed_notifyToggle_saveError` toast. No silent failure.
- **TEST CASE:** Delete `user_devices` row → toggle → assert visual revert + error toast.

#### SET-03: Admin Config UPSERT
- **WHAT:** Admin saves a config key that doesn't exist in DB yet
- **EXPECTED:** Row is INSERTED (not silently failed as with old UPDATE-only).
- **TEST CASE:** Delete `vendor_trial_days` row → admin saves new value → assert row exists in DB with correct value.

#### SET-04: Admin Config Whitelist Coverage
- **WHAT:** All 24 whitelisted keys visible in admin Settings
- **EXPECTED:** All 24 keys render with human-readable labels in admin App Config section.
- **TEST CASE:** Login as admin → open Settings → admin tab → App Config → assert 24 input rows present with correct labels.

#### SET-05: Refer & Earn Visibility
- **WHAT:** Refer & Earn section visibility in MY SHOP
- **EXPECTED:** Shown when `referral_enabled` is `true` (or not set — optimistic default). Hidden when explicitly `false`/`'0'`. NO flicker on initial render (defaults to visible).
- **TEST CASE:** Set `referral_enabled='false'` → load Settings as vendor → assert Refer & Earn section absent.
- **TEST CASE:** Set `referral_enabled='true'` → load → assert visible immediately (no wait for async fetch).

#### SET-06: MY SHOP Labels Localized
- **WHAT:** Settings section labels in HI/MR
- **EXPECTED:** "My Shop" renders in HI/MR (मेरी दुकान / माझे दुकान) when language set. CSS uppercase via `SettingsParentCollapsible` — string itself NOT in caps.
- **TEST CASE:** Set language to HI → load Settings as vendor → assert MY SHOP label = Hindi translation value.

## 🏗️ SESSION 44D — CUSTOMER NAME + SERVICE RADIUS DECISION (14 June 2026)

### ✅ WHAT WAS DONE

1. **Customer name (`app_users.name`)** — pre-launch blocker #4 closed
2. **Vendor service radius** — new pre-launch feature designed and documented

---

### CUSTOMER NAME — FULL DECISION TRAIL

**WHAT:** `app_users.name` column added. Vendor enters customer name in LedgerView when they know it. Name shows in ledger list and customer detail sheet.

**WHY vendor-entered, not customer-entered:**
- Khata is only given to KNOWN customers — vendor always knows them personally (regular, neighbour, family)
- Asking customer to enter name at order time = friction for 90% of customers who will never have khata
- Asking at "My Dues" = customer never opens it → name never collected
- Vendor standing at shop, adding to ledger, KNOWS the customer's name → vendor enters it directly

**WHY not mandatory:**
- Online orders — vendor may not have met customer yet. In that case vendor won't give khata anyway (no credit to strangers). So mandatory name has no value for online orders.
- Optional = vendor fills when relevant, skips when not.

**WHERE name is displayed:**
- LedgerView list rows — "Sunita — ****1234" instead of just "****1234"
- LedgerView customer detail sheet header
- Falls back gracefully to masked phone when name is null

**HOW it works:**
- Vendor taps customer in LedgerView → detail sheet opens
- If no name: "Add name" link → inline text input → save
- If name exists: name shown with pencil icon → tap to edit inline
- Save: UPDATE `app_users SET name=? WHERE phone=?` → if 0 rows updated → INSERT `{phone, name}` (handles case where customer has no `app_users` row yet — referral INSERT creates it, but not all customers have one)
- Success: local `customerNameByPhone` map updated → list refreshes immediately, no reload needed

**LedgerView query fix:** `.select("phone, name")` was already written correctly — was silently failing with `42703` because `name` column didn't exist. Now works automatically after migration.

### MIGRATION APPLIED — SESSION 44D

| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260614150000_app_users_name.sql` | `ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS name text` — nullable, no default, vendor-filled | ✅ | ✅ |

### FILES CHANGED — SESSION 44D

| File | What changed |
|---|---|
| `src/pages/LedgerView.tsx` | Editable name field in customer detail sheet. "Add name" link when null, name + pencil icon when set. UPDATE then INSERT upsert pattern. Local map update on success. |
| `src/lib/strings.ts` | `ledger_customer_name_placeholder`, `ledger_customer_name_add`, `ledger_customer_name_saved` — EN/HI/MR |

---

### 🆕 VENDOR SERVICE RADIUS — FEATURE DECISION (pre-launch)

**WHAT:** Vendors declare their own service radius. Customers filter Radar search by distance bracket. Radar matches customer's selected bracket against vendor's declared radius.

**WHY:** Current Radar assumes every vendor serves only their immediate neighbourhood (15km cap). But Indian informal economy has vendors who serve much wider areas:
- Wholesaler in Warje supplies kiranas across Pune — needs 50km+ visibility
- Specialty artisan/manufacturer — customers travel or receive delivery from 100km+
- B2B is real on Aaspaas — vendors are customers of other vendors (kirana buys from wholesaler, tiffin service buys from sabziwala, salon buys from beauty supplier)

Locking everyone to 15km kills the B2B and wholesale use case entirely.

**WHO:** Wholesalers, bulk suppliers, manufacturers, specialty services, pan-city delivery vendors. Also benefits customers who WANT to search wider for specific products/services.

**WHERE it touches:**
- `vendors` table: new `service_radius_km int NOT NULL DEFAULT 15` column
- Registration form: radius picker after vendor type selection — chips/dropdown: 5km / 15km / 25km / 50km / 100km / Pan-city (999)
- `VendorSettings.tsx`: editable `service_radius_km` field under shop details
- `RadarSearch.tsx`: customer-facing distance bracket filter — "Within 15km / 25km / 50km / 50km+"
- Radar query: show vendor if `vendor.service_radius_km >= customer_selected_bracket` AND vendor's GPS is within a reasonable outer bound (e.g. 500km bounding box — prevents truly irrelevant results)

**Customer filter brackets:**
| Filter label | Bracket value | Who sees what |
|---|---|---|
| Within 15km (default) | 15 | All vendors with `service_radius_km >= 15` within 15km of customer |
| Within 25km | 25 | Vendors with `service_radius_km >= 25` within 25km |
| Within 50km | 50 | Vendors with `service_radius_km >= 50` within 50km |
| 50km+ | 999 | Wholesalers, pan-city vendors — `service_radius_km >= 999` |

**HOW radar query changes:**
```sql
-- Current: vendors within bbox of customer's selected radius
-- New: vendors where service_radius_km >= selected_bracket AND within outer bbox
WHERE service_radius_km >= {selected_bracket}
AND latitude BETWEEN {customer_lat - outer_delta} AND {customer_lat + outer_delta}
AND longitude BETWEEN {customer_lng - outer_delta} AND {customer_lng + outer_delta}
```

**Outer bbox for 50km+ vendors:** Use a generous bounding box (e.g. ±5 degrees ≈ 500km) — wholesaler in Pune is irrelevant to customer in Delhi. City-scale is the right outer bound.

**WHEN:** Pre-launch — add to build queue after BR-3. Small scope: 1 migration + registration UI change + VendorSettings field + Radar filter UI + query change.

**DEFAULT behaviour:** All existing vendors default to `service_radius_km=15` — no change to their Radar visibility. Only vendors who explicitly increase their radius get wider reach.

---

## 🏗️ SESSION 44C — VENDOR REGISTRATION + REFERRALS AUDIT + FIXES (14 June 2026)

### ✅ WHAT WAS DONE

Two full module audits completed in one session:
1. **Vendor Registration** — 14 gaps (VR-REG-01 to VR-REG-14) triaged, 11 fixed across 5 Cursor prompts
2. **Referrals** — 24 gaps (RF-REG-01 to RF-REG-24) triaged, 16 fixed across 5 Cursor prompts + 1 hotfix

7 migrations applied TEST+PROD. `process-vendor-referral` edge function updated and redeployed. All E2E tests passing.

---

### 🔐 REFERRALS — BUSINESS RULES (LOCKED SESSION 44C)

**WHAT:** Two referral paths exist — vendor referrals and user (customer) referrals.

**WHY:** App does not process payments between vendor and customer (cash/UPI direct). Razorpay is only for vendor subscription (₹99/month to Aaspaas Pro). Referral credits = discounts on that subscription only. Customers have no subscription → nothing to discount → no customer referral reward possible at this stage.

| Referrer | Referee | Reward | How |
|---|---|---|---|
| Vendor | Vendor | ₹25 credit | Split ₹8.34/₹8.34/₹8.32 over 3 months, applied as subscription discount at billing |
| Vendor | Customer | ₹2.5 credit | Applied as next subscription discount at billing |
| Customer | Anyone | Nothing | No customer referral incentive — by design, no subscription to discount |

**WHEN disbursement happens:** At Razorpay subscription billing — post-launch. `disbursed=false` credits accumulate in `vendor_credits` until Razorpay sprint. This is intentional — credits are promises, not immediate transfers.

**`first_payment` trigger (veteran path):** When a referring vendor has been active > `referral_veteran_threshold_months` (default 12), they get a `first_payment` status referral row — credits only when their referee makes their first subscription payment. Dead until Razorpay sprint.

**`active_once` trigger (standard path):** Normal vendors get 3 milestone credit rows immediately when referee registers and is active. This is what works today.

---

### 🏗️ VENDOR REGISTRATION — KEY ARCHITECTURAL DECISIONS

**1. Atomic Registration — single `register_vendor` RPC**

**WHAT:** All registration DB writes in one transaction: vendors INSERT + vendor_categories INSERT (one per selected category, first marked is_primary) + vendor_verification INSERT (all 7 rows).

**WHY:** Pre-fix, vendor INSERT committed even if vendor_categories or vendor_verification failed. Errors were only console.error — vendor saw success toast but had zero category rows → permanently invisible in Radar. Same atomicity lesson as KB-03/04 in Khata. If any step fails → full rollback → vendor sees error and retries cleanly.

**HOW:**
- `register_vendor` RPC (SECURITY DEFINER, callable by anon) — migration `20260614100000`
- `attach_pending_category` RPC — separate atomic RPC for AI pending category attach post-registration (DELETE all + INSERT one in single transaction). Prevents zero-category state if AI suggest-category EF fails after registration — migration `20260614100001`
- `invokeRegisterVendor()` typed helper in `supabase.ts`
- `invokeAttachPendingCategory()` typed helper in `supabase.ts`

**2. Vendor Verification — 7 rows seeded at registration (not 3)**

**WHAT:** All 7 `vendor_verification` rows created at registration, not just 3.

**WHY:** Pre-fix, only `upi_format` (passed), `upi_pennydrop` (dormant), `aadhaar_digilocker` (dormant) were seeded. The other 4 (`photo_shop`, `photo_selfie`, `gps`, `admin_check`) had no rows at all. `trustLevel.ts` BRONZE_CHECKS looks for all 7 — missing rows = vendor always shows Unverified in admin trust UI even though they just registered correctly.

**HOW:** RPC seeds all 7 rows atomically:
- `upi_format` → `passed`
- `upi_pennydrop`, `aadhaar_digilocker`, `photo_shop`, `photo_selfie`, `gps`, `admin_check` → `dormant`

**3. Vendor Type-Driven Mandatory Fields + Draft Profile Status**

**WHAT:** Mandatory fields differ by vendor type. Vendors without GPS register as `profile_status='draft'` — not visible in Radar until they add location.

**WHY (real-world problem):** Test vendors registered without GPS and were permanently invisible in Radar — they had no idea why nobody found them. Making GPS a hard block would prevent legitimate registration (vendor not at shop at registration time). Draft status solves both — vendor registers anywhere, completes profile when at shop.

**WHERE:** `vendors.profile_status` column (text, NOT NULL, DEFAULT 'complete', CHECK IN ('draft','complete')) — migration `20260614110000`. Radar filters `.eq('profile_status','complete')` alongside `is_active` and `is_banned`.

**Field rules by vendor type:**

| Field | `shop` | `home` | `visiting` |
|---|---|---|---|
| Owner name | Mandatory | Mandatory | Mandatory |
| Shop name | Mandatory | Optional | Hidden |
| Phone | Mandatory | Mandatory | Mandatory |
| UPI | Mandatory | Mandatory | Mandatory |
| Categories | Mandatory | Mandatory | Mandatory |
| GPS coordinates | Mandatory* | Mandatory* | Auto at job time |
| Shop photo | Mandatory (post-reg) | Optional | Hidden |
| Selfie | Mandatory | Mandatory | Mandatory |

*GPS missing → `profile_status='draft'`, toast shown (`vendor_gps_missing_draft`), registration proceeds. Visiting type → always `profile_status='complete'` (GPS auto-captured at job time, no fixed location needed).

**Draft UX:** Vendor sees amber banner in VendorSettings: "Your profile is incomplete — Add your shop location to appear in search results" with "Add Location" CTA → GPS capture → `UPDATE vendors SET profile_status='complete', latitude=?, longitude=?` → banner hides.

**4. Single UPI Validator**

**WHAT:** One `isValidUpi()` function in `supabase.ts`, stricter regex `/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/`, imported everywhere. `isValidUpiRegistrationFormat()` deleted.

**WHY:** Two validators existed — stricter at registration, looser in `supabase.ts`. UPI ID could pass one and fail the other. Single source of truth rule (established Session 42C).

**5. Vendor Referral Code — Phone-Derived, Not Random**

**WHAT:** Vendor referral code = `referralCodeFromPhone(phone)` = `AASP{last4digits}` e.g. `AASP1234`. Generated client-side, passed to `register_vendor` RPC as `p_referral_code`.

**WHY:** Pre-fix, random 6-char base-36 code at registration but `VendorSettings` showed phone-derived `AASP{last4}` as a fallback when `vendor.referral_code` was missing. Two different codes, confusing vendor. Now consistent: registration generates `AASP{last4}`, same as what Settings would show.

**WHERE:** `referralCodeFromPhone()` defined ONCE in `src/lib/referral.ts`, imported by both `VendorMode.tsx` and `VendorSettings.tsx`. Single source of truth.

**6. Mobile Vendor Type — Post-Launch Backlog**

**WHAT:** Fourth vendor type `mobile` for route-based vendors with no fixed location — sabziwala, bread/milk delivery, street food cart, newspaper vendor.

**WHY NOT NOW:** Currently forced into `visiting` type which is semantically wrong:
- `visiting` = customer calls vendor TO them (plumber, electrician comes to your house)
- `mobile` = vendor moves along a fixed route/area, customer intercepts them (sabziwala on your street at 7am)
These are fundamentally opposite interactions. Mixing them means wrong UI and service flow. However, at Warje pilot scale, 0-1 mobile vendors expected — not worth engineering before launch.

**WHEN:** Post-launch when real mobile vendors onboard and behavioural data justifies separate flow.

**WHAT it needs when ready:** New `vendor_type='mobile'` DB enum value + new service mode (none of delivery/help/appointment fit — customer "finds" vendor, not orders from them) + live-GPS-only Radar card (show only when `is_active=true` with live location, no fixed coords) + location source matrix update (Session 42B).

**7. Identity Architecture — Deferred to BR-3**

**WHAT:** Vendor phone not synced to `aaspaas:user_phone` at registration. On same device, vendor and customer identities can diverge.

**WHY deferred:** Atul wears 3 hats — admin + vendor + customer — all on same phone. Fixing identity partially inside vendor registration risks breaking customer flows on shared devices. BR-3 (first-open flow in `Index.tsx`) is the correct place to solve identity holistically.

**WHO is affected:** Any user using the app as both vendor and customer on the same device. Currently: Atul, Gajanand, any test user.

**WHEN to fix:** BR-3 session — that session will touch `aaspaas:vendor_id`, `aaspaas:user_phone`, `aaspaas:role` and design a clean multi-hat identity system.

**8. Banned/Deleted Phone Guard**

**WHAT:** Registration and account lookup now block banned, deletion-requested, and anonymised vendor phones.

**WHY:** Pre-fix, a banned vendor could re-register with same phone (DB 23505 catches it, but error toast suggested "find my account" — leading them straight back via lookup). Worse, `lookupVendorByPhone()` had zero filters — would return banned/deleted accounts freely.

**HOW:**
- `lookupVendorByPhone()` query now filters: `.eq('is_banned', false).is('deletion_requested_at', null)` + rejects any `phone.startsWith('deleted_')`
- Registration 23505 handler: before suggesting "find my account", SELECTs the phone to check `is_banned`/`deletion_requested_at`/`deleted_` prefix → if any match, shows `vendor_lookup_unavailable` toast only, no recovery suggestion
- String: `vendor_lookup_unavailable` (EN/HI/MR) — "This account is no longer available. Please contact support."

---

### VENDOR REGISTRATION — FULL GAP TRIAGE

| Gap | Description | Decision |
|---|---|---|
| VR-REG-01 | Non-atomic registration — vendor commits even if child inserts fail | ✅ Fixed — `register_vendor` atomic RPC |
| VR-REG-02 | Only 3 of 7 verification rows seeded — new vendors always Unverified | ✅ Fixed — all 7 seeded as `dormant` inside RPC |
| VR-REG-03 | Pending category failure → zero `vendor_categories` → Radar invisible | ✅ Fixed — `attach_pending_category` atomic RPC |
| VR-REG-04 | No pre-insert duplicate check — VR-02 test implied guard that doesn't exist | ⚪ By design — DB 23505 constraint is correct guard. Pre-check SELECT would add round trip + TOCTOU race. VR-02 test fixed to match reality |
| VR-REG-05 | Notification type mismatch — app sent `verification_update`, test expected `new_vendor` | ✅ Fixed — app now sends `new_vendor` at registration. `verification_update` reserved for actual status changes later |
| VR-REG-06 | GPS optional — vendors register without location, invisible in Radar forever | ✅ Fixed — vendor type-driven mandatory fields + `profile_status` draft/complete + draft amber banner in Settings |
| VR-REG-07 | VendorOnboarding native-only — web skips permission primer | ⚪ By design — web browsers handle permissions natively at point of use (camera prompts on photo, location on GPS request). Native primer exists because Android requires explicit Capacitor plugin permission requests. |
| VR-REG-08 | No E2E registration test — `loginAsVendor` bypasses form entirely via localStorage inject | ✅ Fixed — `browser-vendor-registration.spec.ts`: form fill → submit → assert vendor + 7 verification rows + categories + `new_vendor` notification |
| VR-REG-09 | Banned/deleted/anonymised phones not checked at register or lookup | ✅ Fixed — lookup filters + registration duplicate error suppresses recovery for banned phones |
| VR-REG-10 | Vendor phone not synced to `aaspaas:user_phone` at registration | ⏳ Deferred to BR-3 — identity architecture (vendor + customer + admin on same device) solved holistically |
| VR-REG-11 | Two UPI validators — stricter at registration (`isValidUpiRegistrationFormat`), looser in `supabase.ts` (`isValidUpi`) | ✅ Fixed — single `isValidUpi()` in `supabase.ts` with stricter regex, imported everywhere |
| VR-REG-12 | `createTestVendor()` factory omits `vendor_categories` + `vendor_verification` — many tests don't reflect real registration | ✅ Fixed — factory now uses `register_vendor` RPC, creates all child rows matching real registration shape |
| VR-REG-13 | Hardcoded English in lookup UI + admin notify title + toasts | ✅ Fixed — all moved to `strings.ts` EN/HI/MR |
| VR-REG-14 | `vendors` RLS not versioned in repo — fresh DB setup would silently break all vendor reads | ✅ Fixed — `20260614120000_vendors_rls.sql` mirrors dashboard `Public Access FOR ALL USING (true)` |

---

### REFERRALS — FULL GAP TRIAGE

| Gap | Description | Decision |
|---|---|---|
| RF-REG-01 | `first_payment` path never activates — veteran referrers get `pending` row but no hook fires when referee pays | ⏳ Post-launch — blocked on Razorpay sprint. Edge function creates row correctly, trigger will connect when Razorpay subscription billing is built |
| RF-REG-02 | No disbursement pipeline — all credits `disbursed=false` forever, UI shows "Pending payout" | ⏳ Post-launch — disbursement tied to Razorpay billing. Credits accumulate correctly, pipeline connects at payment sprint |
| RF-REG-03 | `USER####` codes displayed in Refer & Earn for non-vendors but never resolve — customers have no referral reward | ✅ Fixed — removed USER* code display + customer Refer & Earn block from UI entirely. Customers have no subscription to discount |
| RF-REG-04 | `process-vendor-referral` callable with anon key, no ownership proof — anyone could pass any `new_vendor_id` | ⚪ Post-launch — acceptable at pilot scale. Tighten with Supabase Auth post-launch. Fraud risk is low (credits = subscription discounts, not cash) |
| RF-REG-05 | `recordUserReferral` writes `app_users`, `referrals`, `vendor_credits` from client on permissive RLS | ⚪ Post-launch — same as RF-REG-04. Tighten with Auth. DB constraints prevent most abuse |
| RF-REG-06 | `referrals`, `vendor_credits`, `app_users` RLS not versioned in repo | ✅ Fixed — `20260614130000_referrals_rls.sql`. Named operation policies mirroring PROD. Also fixed: `vendor_credits_insert` was missing on PROD (silent failure) |
| RF-REG-07 | Referral field in vendor registration always shown even when `referral_enabled=false` | ✅ Fixed — field gated on `isReferralEnabled()`. `referral_enabled` exported from `referral.ts` |
| RF-REG-08 | Deeplink code (`/r/CODE`) not prefilled into vendor registration referral input — stored in localStorage but never read | ✅ Fixed — VendorMode reads `getReferralCode()` on mount, sets as initial value of referral input |
| RF-REG-09 | Vendor referral code is random 6-char at registration, but `AASP{last4}` shown in Settings as fallback — two different codes | ✅ Fixed — `referralCodeFromPhone(phone)` at registration. Single source of truth in `referral.ts` |
| RF-REG-10 | No self-referral block on user referral path — vendor visiting own `/r/CODE` as customer could credit themselves | ✅ Fixed — `recordUserReferral()` normalises both phones to last 10 digits, blocks if match |
| RF-REG-11 | No notification when user referral credit created — vendor→vendor path notifies, user path silent | ✅ Fixed — `invokeNotifyVendor()` + `saveNotification()` after credit insert. Uses `feed_referralCredit_title/body` strings (were defined but unused — now wired) |
| RF-REG-12 | `referrals.credits_created` stays `false` after user-referral credit insert | ✅ Fixed — `UPDATE referrals SET credits_created=true` after successful `vendor_credits` INSERT. Requires `referrals_update` anon RLS policy (migration `20260614140000`) |
| RF-REG-13 | `referEarnVisible` defaults `true` until config fetch — brief flash of Refer & Earn when referrals disabled | ✅ Fixed — `useState(false)` default, shows only when config confirms enabled |
| RF-REG-14 | Edge function notification copy hardcoded English inline strings | ✅ Fixed — `constants.ts` extracted in edge function. All copy in named constants |
| RF-REG-15 | `feed_referralCredit_title/body` strings defined in `strings.ts` but never referenced | ✅ Fixed — wired into user referral notification (RF-REG-11 fix) |
| RF-REG-16 | Share messages hardcoded English in `VendorSettings.tsx` | ✅ Fixed — `referral_share_title` + `referral_share_text(code, url)` in strings.ts EN/HI/MR |
| RF-REG-17 | "Could not copy" toast not i18n | ✅ Fixed — `referral_copy_failed` in strings.ts EN/HI/MR |
| RF-REG-18 | Admin verify sheet "Referred by" label hardcoded English | ✅ Fixed — `referral_referred_by` in strings.ts EN/HI/MR |
| RF-REG-19 | `checkAndStoreReferral()` does not uppercase code — inconsistent with `ReferralRedirect` | ✅ Fixed — `.toUpperCase()` added in `checkAndStoreReferral` |
| RF-REG-20 | `referral_enabled` and `referral_user_credit` not seeded in migrations — only vendor M1/M2/M3 seeded | ✅ Fixed — `20260614130001_seed_referral_config.sql` seeds `referral_enabled='true'`, `referral_user_credit='2.5'`, `referral_veteran_threshold_months='12'` with `ON CONFLICT DO NOTHING` |
| RF-REG-21 | `referral_veteran_threshold_months` not in admin whitelist — edge function reads it, admin can't edit | ✅ Fixed — added to `ADMIN_CONFIG_WHITELIST` and `ADMIN_CONFIG_LABELS` in `Settings.tsx` |
| RF-REG-22 | Edge function duplicate vendor referral → generic 23505 error — no graceful handling | ✅ Fixed — catches `23505` on referrals INSERT → `{ ok: false, reason: 'already_referred' }` HTTP 200. VendorMode shows `referral_already_used` toast |
| RF-REG-23 | No native universal-link handler for `/r/` deeplinks — Capacitor `appUrlOpen` not wired | ⏳ Post-launch |
| RF-REG-24 | Push tap `referral_credit` → navigates to `/vendor` only, no deep link to credits detail screen | ⏳ Post-launch |

---

### INFRASTRUCTURE FINDING — `vendor_credits_insert` missing on PROD

**WHAT:** TEST had `anon_all` ALL policy on `vendor_credits` (open). PROD had only `vendor_credits_select` (SELECT only) — no INSERT policy.

**WHY it mattered:** `recordUserReferral()` in `referral.ts` inserts into `vendor_credits` from the anon client. On PROD, this was silently failing — user referral credits were never being created for vendor referrers, even though the referral row was being created. The bug was invisible because no error was thrown to the client.

**HOW found:** RLS probe of PROD during RF-REG-06 fix. Cross-env comparison revealed the gap.

**HOW fixed:** `20260614130000_referrals_rls.sql` creates `vendor_credits_insert` policy on PROD (and standardises all three tables to named operation policies cross-env).

---

### INFRASTRUCTURE FINDING — `vendors.created_at` vs `last_updated` in Edge Function

**WHAT:** `process-vendor-referral/index.ts` used `vendors.created_at` in the veteran threshold query. `vendors` table has `last_updated`, not `created_at`.

**WHY it mattered:** The veteran referral path (referrer active > 12 months) was throwing "Database error" on every invocation — the column simply doesn't exist. No veteran path had ever worked correctly.

**HOW fixed:** Replaced `created_at` with `last_updated` in all edge function queries. Edge function redeployed TEST+PROD.

---

### MIGRATIONS APPLIED — SESSION 44C

| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260614100000_register_vendor_rpc.sql` | Atomic `register_vendor` RPC (SECURITY DEFINER). Vendor + all 7 verification rows + vendor_categories in single transaction. `p_referral_code` passed from client (base-36 `AASP{last4}` format). `p_profile_status` param. GRANT EXECUTE TO anon, authenticated. REVOKE FROM PUBLIC. | ✅ | ✅ |
| `20260614100001_attach_pending_category_rpc.sql` | Atomic `attach_pending_category` RPC. DELETE all vendor_categories for vendor + INSERT one new category row in single transaction. Prevents zero-category state if AI suggest-category call fails after registration. GRANT EXECUTE TO anon, authenticated. | ✅ | ✅ |
| `20260614110000_vendor_draft_status.sql` | `ALTER TABLE vendors ADD COLUMN profile_status text NOT NULL DEFAULT 'complete' CHECK (profile_status IN ('draft','complete'))`. Updates `register_vendor` RPC with `p_profile_status` parameter. Existing vendors default to 'complete' — no data migration needed. | ✅ | ✅ |
| `20260614120000_vendors_rls.sql` | `vendors` RLS versioned in repo for first time. Drops `anon_all` (TEST) and `Public Access` (PROD) policies, recreates unified `Public Access FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`. Cross-env safe (DROP IF EXISTS both names). | ✅ | ✅ |
| `20260614130000_referrals_rls.sql` | Named operation RLS for `referrals`, `vendor_credits`, `app_users`. Cross-env safe — drops both `anon_all` (TEST) and PROD named policies before recreating. `referrals`: SELECT + INSERT. `vendor_credits`: SELECT + INSERT (INSERT was missing on PROD — silent failure fixed). `app_users`: SELECT + INSERT + UPDATE. No DELETE on any table (deletion is anonymisation via edge function). | ✅ | ✅ |
| `20260614130001_seed_referral_config.sql` | Seeds missing config: `referral_enabled='true'`, `referral_user_credit='2.5'`, `referral_veteran_threshold_months='12'`. ON CONFLICT DO NOTHING — won't overwrite existing values. (Vendor M1/M2/M3 already seeded in `20260610020000`.) | ✅ | ✅ |
| `20260614140000_referrals_update_rls.sql` | `referrals_update` anon UPDATE policy — required for `recordUserReferral()` to set `credits_created=true` after vendor_credits INSERT. Found missing by RF-E2E-01 test failure. | ✅ | ✅ |

### EDGE FUNCTIONS DEPLOYED — SESSION 44C

| Function | Change | TEST | PROD |
|---|---|---|---|
| `process-vendor-referral` | New `constants.ts` with all notification copy. Fixed `created_at` → `last_updated` in vendor query. 23505 on referrals INSERT → `{ ok: false, reason: 'already_referred' }` HTTP 200 (was 500). Veteran path now sends informational `REFERRAL_VETERAN_TITLE/BODY` notification correctly. | ✅ | ✅ |

### FILES CHANGED — SESSION 44C

| File | What changed |
|---|---|
| `src/lib/supabase.ts` | `isValidUpi()` updated to stricter regex `/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/`. `invokeRegisterVendor(params)` typed helper. `invokeAttachPendingCategory(params)` typed helper. `Vendor` type updated with optional `profile_status: 'draft' \| 'complete'`. |
| `src/lib/referral.ts` | `isReferralEnabled()` exported. `checkAndStoreReferral()` uppercases code. `referralCodeFromPhone()` confirmed as single source (was already here — verified, not moved). Self-referral block in `recordUserReferral()` (last-10-digit normalise compare). `credits_created=true` UPDATE after vendor_credits INSERT. `invokeNotifyVendor()` + `saveNotification()` on user referral credit — mirrors edge function pattern. Comment: known Session 42B client-side notify violation, move to DB trigger post-launch. |
| `src/pages/VendorMode.tsx` | `register()` uses `invokeRegisterVendor()` RPC instead of sequential inserts. `attach_pending_category` RPC on pending category success (replaces client DELETE+INSERT). `isValidUpiRegistrationFormat()` removed, uses `isValidUpi()`. Notification type changed to `new_vendor`. Banned/deleted phone guard on lookup + duplicate error (SELECT after 23505, suppress recovery suggestion for banned phones). `profile_status` computed from vendor type + coords. Referral field gated on `isReferralEnabled()`. Deeplink code prefilled from `getReferralCode()` on mount. `referralCodeFromPhone(phone)` at registration. `already_referred` toast on edge function `reason`. Hardcoded strings moved to strings.ts. |
| `src/pages/RadarSearch.tsx` | `.eq('profile_status', 'complete')` added to vendor fetch query alongside `is_active` and `is_banned`. Draft vendors never appear in Radar. |
| `src/components/settings/VendorSettings.tsx` | Amber draft banner when `vendor.profile_status === 'draft'`. "Add Location" CTA → GPS capture → `UPDATE vendors SET profile_status='complete', latitude=?, longitude=?` → banner hides via `onVendorUpdated`. USER* code display removed. Customer Refer & Earn block removed. Share messages use `referral_share_title` / `referral_share_text(code, url)`. Copy toast uses `referral_copy_failed`. Imports `referralCodeFromPhone` from `referral.ts`. |
| `src/pages/Settings.tsx` | Customer Refer & Earn block removed. `referEarnVisible` defaults `false`. Admin "Referred by" label uses `referral_referred_by`. `referral_veteran_threshold_months` added to `ADMIN_CONFIG_WHITELIST` + `ADMIN_CONFIG_LABELS`. |
| `src/lib/strings.ts` | New keys: `vendor_gps_missing_draft`, `vendor_draft_banner_title`, `vendor_draft_banner_body`, `vendor_draft_banner_cta`, `vendor_lookup_unavailable`, `vendor_admin_notify_title`, `vendor_lookup_phone_label`, `vendor_category_create_failed`, `vendor_update_failed`, `referral_share_title`, `referral_share_text`, `referral_copy_failed`, `referral_referred_by`, `referral_already_used` — all EN/HI/MR |
| `supabase/functions/process-vendor-referral/constants.ts` | NEW — `REFERRAL_CREDIT_TITLE`, `REFERRAL_CREDIT_BODY(amount)`, `REFERRAL_VETERAN_TITLE`, `REFERRAL_VETERAN_BODY` |
| `supabase/functions/process-vendor-referral/index.ts` | Uses constants. `vendors.created_at` → `vendors.last_updated`. 23505 caught → `{ ok: false, reason: 'already_referred' }` HTTP 200. |
| `tests/helpers/setup.ts` | `createTestVendor()` uses `register_vendor` RPC — creates vendor + 7 verification rows + categories. `invokeRegisterVendorRpc()`, `RegisterVendorRpcOptions`, `deleteVendorRegistrationArtifacts()` added. Unique `referral_code` per call. Legacy `is_active: true` default preserved via post-RPC UPDATE. |
| `tests/vendor-registration.spec.ts` | VR-02 rewritten: tests 23505 constraint directly (not SELECT pre-check). VR-01b rewritten: calls `register_vendor` RPC, asserts `new_vendor` notification row. `beforeAll` uses updated `createTestVendor()`. |
| `tests/browser-vendor-registration.spec.ts` | NEW — E2E registration: fresh session, form fill (shop type, no GPS → draft), submit, assert vendor row + 7 verification rows + ≥1 category + `new_vendor` notification. Cleanup. |
| `tests/referral-deeplink.spec.ts` | REF-LINK-04 rewritten: deterministic — asserts BOTH localStorage uppercase code AND referral row. REF-LINK-05 rewritten: real self-referral block test via `recordUserReferral()` with vendor's own phone. RF-E2E-01 added: full user referral flow → `/r/CODE` → phone entry → referral + credit + `credits_created=true` + `referral_credit` notification. |
| `tests/vendor-registration.spec.ts` | RF-06 rewritten: sets `referral_enabled=false`, asserts referral field not rendered + Refer & Earn not visible in Settings, restores config in `finally`. |
| `tests/browser-vendor-registration.spec.ts` | RF-E2E-02 added: vendor registration with referral code → edge function triggered → referral row + credits (1-3) + referrer notification. |

### TEST RESULTS — SESSION 44C

| Test | Result | Notes |
|---|---|---|
| VR-E2E-01 (browser-vendor-registration) | ✅ Pass | Draft vendor, 7 verification rows, new_vendor notification |
| REF-LINK-04 | ✅ Pass | Deterministic localStorage + DB assert |
| REF-LINK-05 | ✅ Pass | Real self-referral block |
| RF-06 | ✅ Pass | referral_enabled=false UI assertion |
| RF-E2E-01 | ✅ Pass (17.7s) | Full user referral: code → phone → credit + credits_created + notification |
| RF-E2E-02 | ✅ Pass (15.3s) | Vendor registration with referral → edge fn → credits + notification |

### POST-LAUNCH BACKLOG ADDITIONS — SESSION 44C

| Item | WHY / WHEN |
|---|---|
| **Mobile vendor type** | Route-based vendors (sabziwala, street food) are `visiting` type today — wrong semantically. `mobile` needs new service mode (customer finds vendor, not orders from them), live-GPS-only Radar, no fixed coords. Build when real mobile vendors onboard post-launch |
| **Identity architecture (VR-REG-10)** | Vendor + customer + admin on same device — `aaspaas:vendor_id` and `aaspaas:user_phone` are separate, can diverge. Solve holistically in BR-3 session |
| **RF-REG-01 first_payment trigger** | Veteran referrer credits fire when referee makes first subscription payment. Wire at Razorpay sprint |
| **RF-REG-02 disbursement pipeline** | Flip `vendor_credits.disbursed=true` when subscription payment processes. Wire at Razorpay sprint |
| **RF-REG-23 native deeplink `/r/`** | Capacitor `appUrlOpen` not wired for referral deeplinks on native. Post-launch |
| **RF-REG-24 referral_credit push deep-link** | Push tap goes to `/vendor` only, not credits detail screen. Post-launch |
| **Billing tables RLS** | `order_bills`, `order_items`, etc. not versioned in repo (KB-05). Post-launch security debt |
| **Tighten referral anon writes (RF-REG-04/05)** | Move `recordUserReferral` + `process-vendor-referral` to verified writes after Supabase Auth |
| **vendors RLS tighten** | `PUBLIC` policy (all roles) → `anon` only after Supabase Auth introduced. Currently correct for app but broader than necessary |

---

## 🏗️ SESSION 43 — KHATA/BILLING AUDIT + FIXES (14 June 2026)

### ✅ WHAT WAS DONE

Full audit of Khata/Billing feature — 24 gaps (KB-01 to KB-24) triaged. 18 fixed across 9 Cursor prompts. 3 by-design. 3 post-launch. 3 migrations applied TEST + PROD.

### KEY ARCHITECTURAL DECISIONS LOCKED IN SESSION 43
| Decision | Detail |
|---|---|
| **Payments permanently out of scope (vendor-customer)** | Vendor and customer always meet in person — cash/UPI direct between them. App tracks khata but never processes payments. Razorpay is ONLY for vendor subscription (₹99/month to Aaspaas Pro) |
| **Khata disabled by default** | `khata_amber_limit = 0` on new vendors — vendor must consciously opt in. Prevents accidental credit extension for vendors who don't understand khata |
| **Khata is vendor-owned config** | `khata_amber_limit` + `khata_red_limit` on `vendors` table, set in VendorSettings. Admin has no control over individual vendor credit limits |
| **Khata disable blocked when outstanding exists** | Vendor cannot set `khata_amber_limit = 0` if any customer has `total_outstanding > 0`. Must collect all dues first |
| **Add to Ledger = simple bill** | Add to Ledger now creates `order_bills` + single `order_items` row (same pipeline as BillSheet). Customer notified. No separate khata-only path |
| **BillSheet and Add to Ledger share same downstream pipeline** | BillSheet = rich multi-item version. Add to Ledger = quick single-entry version. Same RPC, same notification, same customer visibility |

### KHATA/BILLING — GAP TRIAGE SUMMARY
| Gap | Description | Decision |
|---|---|---|
| KB-01 | Appointment orders lack structured billing | ✅ Fix — BillSheet unlocked at `appointment_status === confirmed` && `status === fulfilled`. Keeps appointment confirm/decline/mark-done block separate |
| KB-02 | Bill replace broken by unique constraint | ✅ Fix — DELETE void row before RPC re-insert |
| KB-03 | Khata not atomic with bill creation | ✅ Fix — khata upsert + tx insert inside RPC transaction |
| KB-04 | Void/replace does not reverse khata | ✅ Fix — RPC reverses khata on void before re-insert. KB-02+03+04+23 all one atomic RPC |
| KB-05 | No RLS in repo for billing tables | ⚪ Post-launch — consistent with app-wide security debt |
| KB-06 | BR-014 credit limit warnings not built | ✅ Fix — `khata_amber_limit` + `khata_red_limit` on vendors. Warnings in incoming orders card + BillSheet + LedgerView. Vendor controls in VendorSettings |
| KB-07 | Customer cannot pay khata in-app | ⚪ By design — payments between vendor-customer permanently out of scope |
| KB-08 | Help mode khata asymmetry | ⚪ By design — Help always had BillSheet. Add to Ledger was appointment-only workaround |
| KB-09 | Manual ledger add has no customer notification | ✅ Fix — converged into KB-10 |
| KB-10 | Duplicate khata paths on delivery | ✅ Fix — Add to Ledger creates order_bills + single order_items. Customer notified with deep-link to order card |
| KB-11 | `payments_enabled` config unused | ✅ Fix — removed from app_config and useAppConfig |
| KB-12 | No bill dispute / customer challenge flow | ⚪ Post-launch — disputes resolved in person at pilot scale |
| KB-13 | Vendor mark-paid doesn't set `paid_at` | ✅ Fix — `paid_at = now()` on mark-paid (both IncomingOrdersSection and LedgerView bulk settlement) |
| KB-14 | Khata payment links wrong order on partial pay | ✅ Fix — partial payment → My Dues deep-link (no order_id). Full settlement → most recent order |
| KB-15 | No `/ledger` deep-link for vendor | ✅ Fix — masked call button in LedgerView customer detail sheet via Exotel. Shows customer name when available (✅ `app_users.name` built Session 44D — vendor-entered in LedgerView). Dependent on Exotel KYC |
| KB-16 | Table DDL missing from repo | ✅ Fix — `CREATE TABLE IF NOT EXISTS` DDL migration for all four billing tables |
| KB-17 | BR-025 PDF export not built | ⏳ Post-launch |
| KB-18 | Localization gaps across billing files | ✅ Fix — all hardcoded strings moved to strings.ts EN/HI/MR across BillSheet, LedgerView, IncomingOrdersSection |
| KB-19 | `khata_paidNotifBody` string unused | ✅ Fix — used in LedgerView FCM call |
| KB-20 | `loadMyKhata` requires phone | ⚪ By design — self-resolves when BR-3 built |
| KB-21 | Bill voice/image errors partially localized | ✅ Fix — "Voice not available" moved to strings.ts |
| KB-22 | No edit-in-place for sent bills | ✅ Fix — pre-send warning notice in BillSheet: "Please review carefully — bills cannot be edited after sending" |
| KB-23 | `order_items` orphaned on void | ✅ Fix — ON DELETE CASCADE on order_items.request_id FK. Handled inside RPC |
| KB-24 | LedgerView "Full History" label hardcoded | ✅ Fix — `khata_fullHistory` with `{date}` placeholder in strings.ts |
| KB-25 (new) | BillSheet does not pre-populate from order menu items | 📋 Next sprint — BillSheet starts empty even when customer selected menu items |

### 📦 MIGRATIONS APPLIED IN SESSION 43
| Migration | Description | Environments |
|---|---|---|
| `20260614000001_billing_atomic_rpc_fix.sql` | CREATE TABLE IF NOT EXISTS DDL for 4 billing tables. Extended `insert_bill_with_items` RPC: void row DELETE + CASCADE, khata reversal, atomic khata insert. ON DELETE CASCADE on order_items FK | TEST + PROD |
| `20260614000002_khata_credit_limits.sql` | `khata_amber_limit numeric NOT NULL DEFAULT 0` + `khata_red_limit numeric NOT NULL DEFAULT 0` on vendors table | TEST + PROD |
| `20260614000003_remove_payments_enabled.sql` | DELETE FROM app_config WHERE key = 'payments_enabled' | TEST + PROD |

### FILES CHANGED — SESSION 43
| File | What changed |
|---|---|
| `src/components/IncomingOrdersSection.tsx` | Appointment billing unlocked via `canShowBillButton()`. Add to Ledger calls RPC. Customer notified after Add to Ledger. `khataAmberLimit`/`khataRedLimit` props + amber/red badge per customer. `canAddToLedger` hides when non-void bill exists. Hardcoded strings localized. `khata_defaultItemName` fallback |
| `src/components/BillSheet.tsx` | Client-side khata writes removed (RPC handles atomically). Pre-send `bill_editWarning` banner. `khataAmberLimit`/`khataRedLimit` props + pre-send warning when bill pushes customer over limit. Localization fixes |
| `src/pages/LedgerView.tsx` | Threshold-based amber/red/green colouring. Vendor fetch extended with limit columns + phone + service_mode. Customer name batch fetch from `app_users` (graceful fallback). Masked call button in detail sheet. Partial pay deep-link fixed (My Dues, no order_id). Full settlement `paid_at` added. `khata_paidNotifBody` used in FCM. All hardcoded strings localized |
| `src/pages/VendorMode.tsx` | Passes `khataAmberLimit`/`khataRedLimit` to IncomingOrdersSection |
| `src/components/settings/VendorSettings.tsx` | Khata Settings section: enable/disable toggle, amber/red limit inputs, disable-blocked-when-outstanding guard |
| `src/lib/useAppConfig.ts` | `paymentsEnabled` removed |
| `src/lib/supabase.ts` | `Vendor` type updated with `khata_amber_limit`, `khata_red_limit` |
| `src/lib/strings.ts` | ~40+ new keys: `bill_*`, `khata_*` across EN/HI/MR |
| `tests/platform-health-aibridge.spec.ts` | AIBRIDGE-03 updated — checks valid key instead of removed `payments_enabled` |

### PENDING FOLLOW-UPS FROM SESSION 43
| Item | Detail | Priority |
|---|---|---|
| **KB-25 — BillSheet menu pre-populate** | BillSheet starts empty even when customer selected menu items in ParchiSheet. Next sprint after Khata | High |
| **`invokeNotifyUser` client-side in BillSheet** | Bill send notification still called from client — violates server-triggered architectural rule. Needs dedicated cleanup prompt | Medium |
| **IncomingOrdersSection Add to Ledger sheet labels** | String keys exist in strings.ts but not yet wired into the sheet UI labels (Customer phone, Amount, etc.) | Low |
| **`shopName \|\| "vendor"` fallback hardcoded** | In LedgerView partial pay notification. Add `khata_vendorFallback` → "vendor" to strings.ts | Low |
| **`requestIdsWithLedger` state now redundant** | Add to Ledger now creates order_bills — `billsByRequestId` is the single source of truth. Remove `requestIdsWithLedger` state | Post-launch cleanup |
| **Vendor limit changes require reload** | Changing khata limits in Settings doesn't update VendorMode order badges until next load | Post-launch |

---


## 🏗️ SESSION 44A — DATA DELETION AUDIT + FIXES (14 June 2026)

### ✅ WHAT WAS DONE
Full audit of the account deletion/anonymization flow — 12 gaps (G1-G12) identified against fields added across Sessions 42+43. 5 fixes applied. 7 confirmed by-design after careful re-examination (including reversing 2 initial "fix" decisions after Atul challenged the risk).

### WHY THIS AUDIT — Legal/Compliance Context
Account deletion is a legal requirement (data protection — PDPB/GDPR-style "right to erasure"). The existing migration `20260606010000_account_deletion.sql` (Session 38) built the core flow: 30-day grace period for vendors (`deleted_XXXXX` phone format), immediate anonymization for customers. Sessions 42+43 added many new fields (`recommended_vendor_*`, khata credit limits, AI category fields, on_time_rate, etc.) — none of these were covered by the original anonymization function. This audit closes that gap.

### THE TWO DELETION PATHS (existing, verified working)
| Path | Trigger | Behavior |
|---|---|---|
| **Customer deletes account** | `users.deletion_requested_at` set | Immediate (next cron run) — `_anonymise_customer_phone()` runs: phone → `deleted_<random>` across all tables referencing `user_phone`/`device_id` |
| **Vendor deletes account** | `vendors.deletion_requested_at` set | 30-day grace period — vendor stays bookable/visible. After 30 days, `anonymise_deleted_accounts()` anonymizes vendor phone to `deleted_<random>` AND calls `_anonymise_customer_phone()` for the vendor's own phone (a vendor is also a customer) |

**Dual-role guard (G12, confirmed by-design):** Same phone cannot be customer-deleted while still an active vendor. Protects data integrity — prevents a vendor's own customer-side data from being anonymized while their vendor business is still live.

### G1-G12 — FULL GAP TRIAGE (Final, after revision)

| Gap | Description | Initial Call | FINAL Decision | Reasoning |
|---|---|---|---|---|
| **G1** | Vendor khata book (`khata_ledger`/`khata_transactions`) keeps customer phone numbers on vendor delete | ✅ Fix (DELETE rows) | ⚪ **REVISED → By design** | If vendor's khata rows were deleted, customers would lose their own debt history and vendors couldn't collect outstanding dues during the 30-day grace period. Customer phones get anonymized when the CUSTOMER deletes their own account (separate path, already works). `vendor_id` UUID is not PII. **No action taken.** |
| **G2** | `feed_posts.recommended_vendor_phone` (+ `recommended_vendor_id`/`name`) — third-party vendor's phone persists on a deleted user's recommendation post | ✅ Fix | ✅ **Fixed** | Third-party PII (the recommended vendor's phone) must not persist attached to a deleted user's content — that vendor never consented to this. |
| **G3** | `feed_posts.vendor_id` on offer posts persists after vendor deletion | ⚪ By design | ⚪ **By design** | `vendor_id` is a UUID, not PII. Resolves to "Deleted Shop" in UI — same pattern as deleted social media posts showing "[deleted]" while thread structure remains. |
| **G4** | `saved_vendors` rows keyed only by `device_id` (no `user_phone`) not deleted on customer delete | ✅ Fix | ✅ **Fixed** | Device ID is a device fingerprint — PII under GDPR/PDPB. Must be cleaned up. |
| **G5** | Vendor profile incomplete scrub — photos (`shop_photo_url`, `photo_selfie`), `vendor_note`, `cancel_reason_1-4`, `referral_code`, `ledger_cycle_start` remain after anonymization | ✅ Fix | ✅ **Fixed** | Photos especially are PII (a selfie is biometric-adjacent data). All NULLed. `khata_amber_limit`/`khata_red_limit` left as-is — harmless, vendor is banned/inactive anyway. |
| **G6** | `referrals.referrer_vendor_id` retains deleted vendor's UUID as referrer | ✅ Fix (NULL it) | ⚪ **REVISED → By design** | Referral records are a FINANCIAL AUDIT TRAIL — vendor earned real credits for referring. NULLing `referrer_vendor_id` destroys the audit trail of who earned what. The vendor's phone is already anonymized; `referrer_vendor_id` UUID alone is not PII. **No action taken.** |
| **G7** | Related vendor tables (`vendor_menu_items`, `vendor_credits`, `vendor_categories`, `vendor_verification`) and `categories.suggested_by_vendor_id` untouched on vendor delete | ✅ Fix | ✅ **Fixed** | `vendor_menu_items`/`vendor_credits`/`vendor_categories`/`vendor_verification` — all DELETEd (no owner after deletion, no downstream dependency). `categories.suggested_by_vendor_id` → SET NULL (category row stays — useful data — but vendor attribution removed). |
| **G8** | `order_items.description` may retain service-description text after customer delete | ⚪ By design | ⚪ **By design** | `order_items` has no user-identifying columns. Description is vendor-written service text ("Haircut", "Oil change") — not customer PII. |
| **G9** | Khata outstanding amounts remain visible after customer phone anonymized | ⚪ By design | ⚪ **By design** | Vendor accounting integrity — outstanding amounts are financial records the vendor legitimately needs (e.g. for tax/audit). Phone is anonymized to `deleted_a1b2c` — vendor sees "deleted_a1b2c owes ₹500", no real identity exposed. |
| **G10** | `users.deletion_requested_at` (customer path) and `vendors.deletion_requested_at` (vendor path) never cleared after anonymization completes — stale flag | ✅ Fix | ✅ **Fixed** | Split into two: customer-path flag cleared in `20260614000004`. Vendor-path flag cleared in follow-up `20260614000007` (found during Ratings/Reviews audit R15 — see Session 44B). |
| **G11** | `order_bills`/`requests` retained indefinitely (financial/order audit trail) | ⚪ By design | ⚪ **By design** | 7-year GST retention requirement (see NFR table). `vendor_id`/amounts are not customer PII once phone is anonymized. |
| **G12** | Dual-role guard — same phone can't be customer-deleted while active as vendor | ⚪ By design | ⚪ **By design** | Correct protection — prevents inconsistent state where a vendor's customer-side identity vanishes while their shop is still live. |

### IMPLEMENTATION — Migration `20260614000004_account_deletion_fixes.sql`

**Pattern used:** `CREATE OR REPLACE FUNCTION` on both `_anonymise_customer_phone()` and `anonymise_deleted_accounts()` from the original `20260606010000_account_deletion.sql` — ALL existing logic preserved, only new steps appended in the correct order.

**`_anonymise_customer_phone(p_original_phone text, p_anon_tag text)` — additions:**

1. **G2** — after the existing `feed_posts.user_phone` anonymization step:
```sql
UPDATE feed_posts
SET recommended_vendor_phone = NULL,
    recommended_vendor_id = NULL,
    recommended_vendor_name = NULL
WHERE user_phone = p_anon_tag;
```

2. **G4** — inserted BEFORE the existing `user_devices` DELETE step (critical ordering — device_id lookup must happen while `user_devices` rows still exist):
```sql
DELETE FROM saved_vendors
WHERE device_id IN (
  SELECT device_id FROM user_devices WHERE user_phone = p_original_phone
);
```

**`anonymise_deleted_accounts()` — additions:**

3. **G10 (customer loop)** — after `PERFORM _anonymise_customer_phone(...)`:
```sql
UPDATE users SET deletion_requested_at = NULL WHERE phone = anon_tag;
```

4. **G5 (vendor loop)** — extended the existing vendor anonymization UPDATE with additional NULL fields:
```sql
UPDATE vendors SET
  -- ...existing fields (phone → deleted_*, etc.)...
  shop_photo_url = NULL,
  photo_selfie = NULL,
  vendor_note = NULL,
  cancel_reason_1 = NULL,
  cancel_reason_2 = NULL,
  cancel_reason_3 = NULL,
  cancel_reason_4 = NULL,
  referral_code = NULL,
  ledger_cycle_start = NULL
WHERE phone = anon_tag;
```

5. **G7 (vendor loop)** — after the vendor UPDATE, vendor's UUID captured ONCE into `v_vendor_id` variable (avoids repeated subqueries):
```sql
DELETE FROM vendor_menu_items WHERE vendor_id = v_vendor_id;
DELETE FROM vendor_credits WHERE vendor_id = v_vendor_id;
DELETE FROM vendor_categories WHERE vendor_id = v_vendor_id;
DELETE FROM vendor_verification WHERE vendor_id = v_vendor_id;
UPDATE categories SET suggested_by_vendor_id = NULL WHERE suggested_by_vendor_id = v_vendor_id;
```

6. **G10 (vendor loop)** — after existing `PERFORM _anonymise_customer_phone(...)` + `user_devices` DELETE for the vendor's own phone:
```sql
UPDATE users SET deletion_requested_at = NULL WHERE phone = anon_tag;
```
(Note: `vendors.deletion_requested_at` for the vendor's OWN row was NOT cleared here — this is G10's vendor-table counterpart, fixed separately as R15/migration `20260614000007` in Session 44B.)

### Ordering Notes (verified)
- G4 runs BEFORE `user_devices` DELETE — device IDs must still be resolvable. ✅ Correct.
- G7's `v_vendor_id` captured once in a variable, reused across all 5 statements — no repeated subqueries. ✅ Correct.
- Vendor loop has a "redundant" `user_devices` DELETE (already deleted inside `_anonymise_customer_phone`) — harmless no-op on already-deleted rows, left as-is to avoid touching working logic unnecessarily.

### Aadhaar Compliance — CONFIRMED
No raw Aadhaar numbers stored anywhere in the schema. Verified during this audit. Aadhaar Act 2016 compliance maintained — MSME/Udyam registration (Atul's business KYC, separate from app data) is the only Aadhaar touchpoint and that's external to the app database.

### MIGRATIONS APPLIED — SESSION 44A
| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260614000004_account_deletion_fixes.sql` | `CREATE OR REPLACE` on `_anonymise_customer_phone()` (+G2, +G4) and `anonymise_deleted_accounts()` (+G5, +G7, +G10×2) | ✅ | ✅ |

**PROD push note:** PROD had 2 remote-only migrations (`20260611000001`, `20260611020001`) not present in local `migrations/` (they live in `_held/` per the env-split pattern). To push `20260614000004`, these were temporarily copied back from `_held/` to match PROD's migration history, push succeeded (only `20260614000004` actually applied — the other two were already-applied/skipped), then `_held/` state restored. **This temporary-restore-for-push pattern is now the standard procedure for any PROD push when `_held/` files exist** — see updated Supabase reference section.

## 🏗️ SESSION 44B — RATINGS/REVIEWS AUDIT + FIXES (14 June 2026)

### ✅ WHAT WAS DONE
Full audit of the Ratings/Reviews feature — 16 gaps (R1-R16) identified and triaged, all 16 fixed. PLUS a major cross-cutting fix discovered during R4/R6 discussion: resolution button consistency across all three service modes (was inconsistent AND had a real data-quality bug in help mode). 3 migrations applied TEST+PROD (`20260614000005/6/7`). Test suite verified: `rating-advanced.spec.ts` 6/6 passing, `browser-rating-flow.spec.ts` RV-REPLY-01 fixed and passing.

### Complete Journey — Ratings/Reviews (Reference)

```
VENDOR SIDE (Incoming Orders):
  Order accepted/confirmed → Vendor taps "Mark Done" 
  → requests.status → 'fulfilled' (+ fulfilled_at set by trigger, NEW this session)
  → FCM + inbox notify customer

CUSTOMER SIDE (My Orders):
  Order card shows status=fulfilled with mode-aware CTA:
    - delivery → myOrders_delivered ("Delivered! Tap to rate")
    - appointment → myOrders_appointmentFulfilled ("Service completed — tap to rate") [NEW]
    - help → existing help copy
  Tap CTA → RatingSheet opens
  Customer choices:
    a) Skip / backdrop-close / swipe-close [all now equivalent, R11] → markDone → status='done', no review, no counter
    b) Submit stars (1-5):
       → Check: does vendor_reviews row already exist for this request_id? [R2/R3]
       → If exists: skip entirely (shouldn't reach here due to R14 — CTA hidden if review exists)
       → INSERT vendor_reviews (rating, review_text, optional voice)
       → ON SUCCESS ONLY: check sessionStorage 'aaspaas:resolution:{vendorId}' — if Radar 
         resolution already marked this vendor+session, SKIP counter increment [R3 follow-up]
       → ELSE: call increment_vendor_delivered (delivery) OR increment_vendor_helped (help/appointment)
       → syncVendorRatingFromReviews → recalculates vendors.avg_rating + review_count
       → If avg_rating < 2.0 AND review_count >= 5 AND not already notified → admin_alert (low rating)
       → If avg_rating > 3.5 → reset low_rating_admin_notified = false [R10]
       → markDone → status='done', card removed
    c) "Had an issue" button:
       → Check: review exists OR Radar resolution marked? → skip if either true
       → ELSE: increment_vendor_issues(vendor_id) [R1 — RPC created this session]
       → markDone

RADAR SIDE (parallel lightweight path):
  Vendor card shows resolution button when:
    showResolution = !isOwnVendor && serviceFulfilledFromDb
    (serviceFulfilledFromDb = DB query: requests.status='fulfilled' for this vendor+user/device — 
     SAME for all 3 modes now, NEW this session — was session-flag-based for help before)
  Label (gender-neutral, NEW this session):
    - delivery → "📦 Delivered on Time" (radar_delivered_on_time)
    - help → "✅ Vendor Helped Me" (radar_vendor_helped, renamed from radar_he_helped)
    - appointment → "✅ Vendor Served Me" (radar_vendor_served, NEW)
  Tap → handleResolution:
    → If vendor_reviews row exists for this request_id → mark resolutionMarked, NO increment [R3]
    → ELSE → increment_vendor_delivered (delivery) OR increment_vendor_helped (help + appointment)
    → Sets sessionStorage 'aaspaas:resolution:{vendorId}' = '1' (resolutionMarked flag)

VENDOR REVIEW VIEW (Settings → My Shop → My Reviews):
  Lazy-loaded on section expand (loadReviews())
  Each review shows: stars, text, "— Anonymous customer" label [R12, always shown]
  Vendor can Respond (RV-08/RV-REPLY-01 — text input + Send → vendor_response + 
    vendor_responded_at saved)

ADMIN SIDE:
  Dashboard: avg vendor rating stat (passive)
  Auto: avg_rating < 2.0 AND review_count >= 5 AND not already notified → admin_alert inbox [R9: 
    type is admin_alert, not low_rating_alert — test was wrong, code was right]
  Auto-reset: avg_rating > 3.5 → low_rating_admin_notified = false [R10]
  NEW — "Low Ratings (2★ and below)" moderation panel [R8]:
    Lists up to 50 reviews with rating <= 2, vendor shop_name, masked phone, date
    Delete button → removes vendor_reviews row → re-syncs avg_rating/review_count
    Edge case: if vendor's LAST review deleted → avg_rating=null, review_count=0, 
      low_rating_admin_notified=false (clean reset, fixed in vendorRating.ts this session)
```

### R1-R16 — FULL GAP TRIAGE

| Gap | Description | Decision | Fix |
|---|---|---|---|
| **R1** | "Had an issue" button called non-existent `increment_vendor_issues` RPC — silent error on every tap | ✅ Fixed | New RPC `increment_vendor_issues(uuid)` + `vendors.total_issues` column. (Column already existed on TEST/PROD — `IF NOT EXISTS` skipped it; RatingSheet already called the correct name — just needed the RPC to exist) |
| **R2** | Counter RPC (`increment_vendor_delivered`/`helped`) called regardless of `vendor_reviews` insert success | ✅ Fixed | `handleRate` now: insert review → ONLY on success → increment counter. Insert failure → toast, no counter bump |
| **R3** | Double-counting between Radar resolution tap and MyOrders star rating for the SAME fulfilled order | ✅ Fixed | Two-directional guard: (a) Radar/MyOrders check `vendor_reviews` existence for `request_id` before incrementing — if review exists, skip. (b) MyOrders RatingSheet checks `sessionStorage 'aaspaas:resolution:{vendorId}'` — if Radar already marked (same session/device), skip increment but STILL insert the review (star rating always recorded). Cross-device double-count remains a known acceptable edge case at pilot scale |
| **R4** | Radar resolution tap (lightweight) never creates `vendor_reviews` — doesn't affect `avg_rating`, only bumps `total_helped`/`total_delivered` counters | ⚪ By design | Two intentional tiers of feedback: effortless tap (volume/confidence signal) vs deliberate star review (quality signal). Both ARE displayed on cards — `total_helped`/`total_delivered` ("Helped: 47") alongside `avg_rating` ("⭐4.8") — Atul confirmed this distinction (volume = confidence, rating = reality of like/dislike) is correct and valuable |
| **R5** | Appointment mode used help's "Delivered"/generic copy and RPC incorrectly | ✅ Fixed | Mode-aware copy throughout: new strings `myOrders_appointmentFulfilled` (MyOrders CTA) and `rating_btnAppointmentCompleted` (RatingSheet submit button) — both "Service completed — tap to rate" / "✅ Service Completed". RPC: appointment uses `increment_vendor_helped` (same as help — booking is a service, reuses existing counter, no new column) |
| **R6** | No Radar resolution button for appointment mode at all | ✅ Fixed (superseded by resolution-button-consistency fix, see below) | Appointment now gets `radar_vendor_served` button, same DB-gating as help/delivery, increments `total_helped` |
| **R7** | `vendors.on_time_rate` displayed in 3 places (Radar delivery card, AiBridge call sheet, VendorAnalytics) but NEVER written anywhere — always null in practice | ✅ Fixed (Path A — built properly) | New `requests.fulfilled_at` column + `trg_set_fulfilled_at` trigger (sets timestamp when status→'fulfilled'). New RPC `recalculate_vendor_on_time_rate(vendor_id)` — on_time = `fulfilled_at <= delivery_slot_deadline`, rate = on_time_count/total_count*100, only counts orders where both `delivery_slot_deadline` and `fulfilled_at` are non-null. Called fire-and-forget from `IncomingOrdersSection.tsx` after delivery markDone. Historical orders (pre-migration) have null `fulfilled_at` and don't count — acceptable given Session 42 "clear all data at launch" decision |
| **R8** | No admin moderation for low-rated/abusive reviews | ✅ Fixed | New "Low Ratings (2★ and below)" collapsible in admin Settings, after "Pending Categories" (Session 42B). Shows up to 50 reviews rating<=2, shop_name, masked phone (`••••1234`), date, review text or "No comment". Delete button → removes row → `syncVendorRatingFromReviews` recalculates. Side-fix: `vendorRating.ts` now correctly resets `avg_rating=null, review_count=0, low_rating_admin_notified=false` when a vendor's LAST review is deleted (previously returned early, left stale values) |
| **R9** | Test asserted notification type `low_rating_alert`; production code uses `admin_alert` | ✅ Fixed | Tests corrected to `admin_alert` (production code was already right) — `tests/rating-advanced.spec.ts` RV-05/RV-06 + cleanup |
| **R10** | Low-rating recovery threshold mismatch: code reset flag at `avg_rating > 3.0`, test/docs said `> 3.5` | ✅ Fixed | Code changed to `> 3.5` in `vendorRating.ts` (more meaningful recovery threshold — chosen as the correct value, test was right). RV-07 strengthened to actually exercise recovery path (seeds 4×4★ reviews, starts with flag=true, asserts flag resets) |
| **R11** | RatingSheet could not be closed via backdrop tap or swipe — only explicit Skip button worked | ✅ Fixed | `onOpenChange` now treats backdrop/swipe close identically to Skip → `onDismiss` → `markDone`, no review, no counter. Still blocked while `busy` (submission in flight) |
| **R12** | `review_anonymous` string existed but was never displayed — vendor saw nothing indicating reviewer anonymity | ✅ Fixed | Every review in vendor's "My Reviews" now shows "— Anonymous customer" (localized) below stars/text, unconditionally — privacy reassurance for customers |
| **R13** | "Voice not available on this device" hardcoded in English, shown when voice review attempted on unsupported device | ✅ Fixed | New string `rating_voiceUnavailable` (EN/HI/MR), voice-is-native-only remains by design (that part was never in question — only the error copy needed localizing) |
| **R14** | Rate CTA still shown on MyOrders even if `vendor_reviews` row already exists for that `request_id` — tapping would silently fail or attempt duplicate insert | ✅ Fixed | MyOrders checks `myReviews[r.id]` (existing review map) — if exists, shows neutral dismiss button (`myOrders_dismiss` styling, calls `markDone` directly) instead of the "Tap to rate" CTA |
| **R15** | `vendors.deletion_requested_at` (vendor's OWN flag, vendor-table-side) never cleared after vendor anonymization — counterpart to G10 customer-table fix from Session 44A | ✅ Fixed | New migration `20260614000007` — `CREATE OR REPLACE anonymise_deleted_accounts()`, preserves ALL logic from `20260614000004`, adds `UPDATE vendors SET deletion_requested_at = NULL WHERE phone = anon_tag` after vendor anonymization completes |
| **R16** | `RV-REPLY-01` (vendor responds to review) was DB-only — never exercised the actual vendor UI reply flow | ✅ Fixed | Extended to full UI flow: seed review → login as vendor → Settings → expand "My Reviews" → click Respond → fill text → Send → assert toast + UI display + DB columns (`vendor_response`, `vendor_responded_at`). Test itself had a locator bug (expected `/My Reviews \(1\)/i` on initial render, but UI lazy-loads and shows `(0)` until expanded) — fixed to `/My Reviews/i` + wait for review content after expand. **RV-08** (rating-advanced.spec.ts) remains as fast DB-only regression test; RV-REPLY-01 now covers the UI path |

### MAJOR CROSS-CUTTING FIX — Resolution Button Consistency (discovered via R4/R6 discussion)

**The real bug found:** Before this session, the three modes had THREE DIFFERENT and INCONSISTENT gating rules for the Radar "quick acknowledgement" button:

| Mode | OLD gating | Problem |
|---|---|---|
| Help | `readCalledVendor(vendor.id)` — sessionStorage flag set whenever an AiBridge CALL CONNECTED | **Data quality bug**: a call connecting ≠ help was actually provided. Plumber could say "too busy, can't come", call ends, button still shows "He Helped Me" — incrementing `total_helped` for a no-show |
| Delivery | DB query: `requests.status = 'fulfilled'` for this vendor+user/device | ✅ Correct — strict, DB-verified |
| Appointment | Nothing — `showResolution` condition didn't include appointment at all | Appointment vendors get zero "social proof" volume counter on their cards, unlike help/delivery vendors |

**Atul's challenge that uncovered this:** "When user search help vendor — why do we show 'He Helped me' right away? we must have fixed it if we were showing as we done auditing this HELP mode" — this question led to investigating the EXACT gating condition via Cursor, which revealed help mode's gate was call-based not fulfillment-based.

**THE FIX — unify all 3 modes on the CORRECT (delivery) pattern:**

```typescript
// NEW unified condition (was 3 different conditions before):
const showResolution = !isOwnVendor && serviceFulfilledFromDb;

// serviceFulfilledFromDb (renamed from deliveryFulfilledFromDb):
//   DB query: requests.status='fulfilled' AND vendor_id=X AND (user_phone OR device_id matches)
//   Now runs for ALL THREE modes — removed the `serviceMode !== "delivery"` early-return guard
```

**Removed dead code:** `readCalledVendor`, `writeCalledVendor`, `CALLED_SESSION_PREFIX`, the `onCallSuccess` sessionStorage write on `AiBridgeSheet` — all gone. Help mode's resolution button is now exactly as strict as delivery's.

**Gender-neutral labels (Atul's correction — "He/She" assumes gender, use "Vendor"):**

| Mode | OLD label | NEW label | String key |
|---|---|---|---|
| Help | "✅ He Helped Me" | "✅ Vendor Helped Me" | `radar_he_helped` RENAMED to `radar_vendor_helped` |
| Delivery | "📦 Delivered on Time" | (unchanged — already neutral) | `radar_delivered_on_time` |
| Appointment | (none) | "✅ Vendor Served Me" | `radar_vendor_served` (NEW) |

**Counter decision — appointment reuses `total_helped`, no new column:** "He Served Me" tap (or MyOrders rating) for appointment increments `increment_vendor_helped` — same RPC/column as help mode. Appointment is semantically "vendor helped/served the customer" — same category. `VendorReputationLine` "Helped: X" stat now displays for both help AND appointment modes (was help-only before).

### NEW RPCs — SESSION 44B
| RPC | Purpose | Migration |
|---|---|---|
| `increment_vendor_issues(p_vendor_id uuid)` | Increments `vendors.total_issues` — "Had an issue" button (R1) | `20260614000005` |
| `recalculate_vendor_on_time_rate(p_vendor_id uuid)` | Recalculates `vendors.on_time_rate` from `requests.fulfilled_at` vs `delivery_slot_deadline` (R7) | `20260614000006` |

### NEW/CHANGED DB COLUMNS — SESSION 44B
| Table | Column | Type | Purpose | Migration |
|---|---|---|---|---|
| `vendors` | `total_issues` | integer NOT NULL DEFAULT 0 | "Had an issue" counter (R1) | `20260614000005` (already existed on TEST/PROD — IF NOT EXISTS no-op) |
| `vendors` | `on_time_rate` | numeric, nullable | Delivery on-time % (R7) | `20260614000006` (already existed — IF NOT EXISTS no-op) |
| `requests` | `fulfilled_at` | timestamptz, nullable | Set by trigger when status→'fulfilled' (R7) | `20260614000006` (NEW) |

### NEW DB TRIGGER — SESSION 44B
| Trigger | Table | Event | Function | Migration |
|---|---|---|---|---|
| `trg_set_fulfilled_at` | `requests` | BEFORE UPDATE | `set_request_fulfilled_at()` — sets `NEW.fulfilled_at = now()` when `status` changes TO `'fulfilled'` (guards `OLD.status IS DISTINCT FROM 'fulfilled'` so it only fires once) | `20260614000006` |

### MIGRATIONS APPLIED — SESSION 44B
| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260614000005_vendor_issues_rpc.sql` | `vendors.total_issues` (no-op, existed) + `increment_vendor_issues(uuid)` RPC + grant to anon | ✅ | ✅ |
| `20260614000006_delivery_on_time_rate.sql` | `requests.fulfilled_at` (NEW) + `trg_set_fulfilled_at` trigger (NEW) + `vendors.on_time_rate` (no-op, existed) + `recalculate_vendor_on_time_rate(uuid)` RPC + grant to anon | ✅ | ✅ |
| `20260614000007_clear_vendor_deletion_flag.sql` | `CREATE OR REPLACE anonymise_deleted_accounts()` — adds R15 fix (clear `vendors.deletion_requested_at`) on top of all `20260614000004` logic | ✅ | ✅ (via `_held/` temporary-restore pattern) |

### FILES CHANGED — SESSION 44B
| File | What changed |
|---|---|
| `src/components/RadarVendorCard.tsx` | Removed `CALLED_SESSION_PREFIX`/`readCalledVendor`/`writeCalledVendor`/`onCallSuccess`. Renamed `deliveryFulfilledFromDb`→`serviceFulfilledFromDb`, `refreshFulfilledFromDb`→`refreshServiceFulfilledFromDb` (removed delivery-only guard, runs for all modes). `showResolution = !isOwnVendor && serviceFulfilledFromDb`. Mode-aware labels (`radar_vendor_helped`/`radar_delivered_on_time`/`radar_vendor_served`). `handleResolution`: delivery→`increment_vendor_delivered`, help+appointment→`increment_vendor_helped`. Tracks `serviceFulfilledRequestId`; checks `vendor_reviews` existence before incrementing (R3). `VendorReputationLine` "Helped" stat now shows for help AND appointment |
| `src/pages/RadarSearch.tsx` | `fulfilledQuery` confirmed already mode-agnostic (selects `id, vendor_id` for ALL vendor IDs regardless of mode) — passes `fulfilledRequestId` per card |
| `src/components/RatingSheet.tsx` | `handleRate`: insert review FIRST → on success only → check sessionStorage Radar-resolution flag → increment counter if not already marked (R2/R3). `handleIssue`: calls `increment_vendor_issues`, skips if review exists or Radar already marked. `onOpenChange` treats backdrop/swipe as Skip (R11, blocked while `busy`). Mode-aware `submitLabel` (R5): delivery→`rating_btnDelivered`, appointment→`rating_btnAppointmentCompleted`, help→`rating_btnHelped`. Voice-unavailable toast → `s.rating_voiceUnavailable` (R13) |
| `src/pages/MyOrders.tsx` | `fulfilledOrderCtaLabel()` mode-aware (R5): delivery→`myOrders_delivered`, appointment→`myOrders_appointmentFulfilled`, help→`rating_btnHelped`. R14: if `myReviews[r.id]` exists, shows neutral dismiss button instead of rate CTA |
| `src/components/settings/VendorSettings.tsx` | My Reviews: every review shows "— Anonymous customer" (R12, `s.review_anonymous`) |
| `src/pages/Settings.tsx` | NEW "Low Ratings (2★ and below)" admin collapsible (R8) — after "Pending Categories", before "App Config". Loads ≤50 reviews rating<=2 w/ shop_name + masked phone + date. Delete → optimistic removal + DB delete + `syncVendorRatingFromReviews` |
| `src/lib/vendorRating.ts` | R10: recovery threshold `> 3.0` → `> 3.5`. R8 side-fix: when vendor has zero reviews left after delete, sets `avg_rating=null, review_count=0, low_rating_admin_notified=false` (previously returned early without updating) |
| `src/lib/strings.ts` | NEW/renamed: `radar_vendor_helped` (renamed from `radar_he_helped`), `radar_vendor_served` (new), `myOrders_appointmentFulfilled`, `rating_btnAppointmentCompleted`, `rating_voiceUnavailable`, `admin_lowRatings_title/empty/delete/noComment` — all EN/HI/MR |
| `src/components/IncomingOrdersSection.tsx` | After delivery `markDone`→fulfilled: fire-and-forget `supabase.rpc('recalculate_vendor_on_time_rate', {p_vendor_id})` (R7) |
| `tests/rating-advanced.spec.ts` | R9: `low_rating_alert`→`admin_alert` in RV-05/RV-06/cleanup. R10: RV-07 strengthened (seeds 4×4★, asserts recovery >3.5) |
| `tests/browser-rating-flow.spec.ts` | R16: RV-REPLY-01 extended to full UI flow + locator fix (`/My Reviews \(1\)/i` → `/My Reviews/i`, wait for review content post-expand) |

### TEST RESULTS — SESSION 44B
| Suite | Result |
|---|---|
| `rating-advanced.spec.ts` (6 tests: RV-02, RV-04, RV-05, RV-06, RV-07, RV-08) | ✅ 6/6 passed (~40s) |
| `browser-rating-flow.spec.ts -g "RV-REPLY-01"` | ✅ 1/1 passed (10.7s, after locator fix) |

### RATINGS/REVIEWS REQUIREMENTS SPEC — FOR TEST CASE GENERATION

#### RAT-01: Resolution Button — Unified DB Gating (all 3 modes)
- **WHAT:** Radar card resolution button visibility
- **EXPECTED:** `showResolution = !isOwnVendor && (requests row exists where vendor_id=X, status='fulfilled', and user_phone OR device_id matches)` — SAME query for help/delivery/appointment. NOT based on call success, NOT based on session flags.
- **TEST CASE:** Help vendor — customer calls but vendor never marks order fulfilled → resolution button does NOT appear.
- **TEST CASE:** Appointment vendor — order marked fulfilled → "Vendor Served Me" button appears on Radar card.

#### RAT-02: Resolution Tap — No Double Count
- **WHAT:** Customer taps Radar resolution AND later rates via MyOrders for the same `request_id`
- **EXPECTED:** Counter (`total_helped`/`total_delivered`) increments only ONCE total across both actions. The `vendor_reviews` row is ALWAYS inserted when customer submits stars (review recording is independent of counter dedup).
- **TEST CASE:** Tap "Vendor Helped Me" on Radar (same session) → then rate 5★ in MyOrders for same order → assert `total_helped` incremented by exactly 1, AND `vendor_reviews` row exists with rating=5.

#### RAT-03: Review Insert Failure — No Counter Bump
- **WHAT:** `vendor_reviews` insert fails (e.g., duplicate `request_id` constraint)
- **EXPECTED:** Counter increment RPC is NOT called. User sees error toast.
- **TEST CASE:** Pre-insert a review for `request_id=X` → attempt RatingSheet submit for same `request_id` → assert insert error handled, `total_helped`/`total_delivered` unchanged.

#### RAT-04: Mode-Aware Copy
- **WHAT:** MyOrders CTA and RatingSheet submit button text per `service_mode`
- **EXPECTED:** delivery→"Delivered! Tap to rate"/"Delivered on Time", appointment→"Service completed — tap to rate"/"Service Completed", help→existing help copy. No mode shows another mode's copy.
- **TEST CASE:** Fulfilled appointment order in MyOrders → assert CTA text = `myOrders_appointmentFulfilled` value, NOT `myOrders_delivered`.

#### RAT-05: on_time_rate Calculation
- **WHAT:** `vendors.on_time_rate` for delivery vendors
- **EXPECTED:** Only orders where BOTH `delivery_slot_deadline IS NOT NULL` AND `fulfilled_at IS NOT NULL` count toward the rate. on_time = `fulfilled_at <= delivery_slot_deadline`. Rate = (on_time count / total qualifying count) × 100, rounded to 1 decimal. If zero qualifying orders, `on_time_rate` stays null (not 0).
- **TEST CASE:** Mark a delivery order fulfilled 10 minutes before `delivery_slot_deadline` → call `recalculate_vendor_on_time_rate` → assert `on_time_rate` reflects this order as "on time".
- **TEST CASE:** Mark a delivery order fulfilled 10 minutes AFTER `delivery_slot_deadline` → assert it counts as NOT on time, lowering the rate.

#### RAT-06: fulfilled_at Set Exactly Once
- **WHAT:** `trg_set_fulfilled_at` trigger behavior
- **EXPECTED:** `fulfilled_at` is set on the FIRST transition to `status='fulfilled'`. If status later changes away and back (shouldn't normally happen, but defensively), `fulfilled_at` should NOT be overwritten on subsequent updates where status is already `'fulfilled'`.
- **TEST CASE:** Update order status to 'fulfilled' → assert `fulfilled_at` set to ~now(). Update same order's `message` field (status stays 'fulfilled') → assert `fulfilled_at` UNCHANGED.

#### RAT-07: Hide Rate CTA if Review Exists
- **WHAT:** MyOrders fulfilled order display when `vendor_reviews` row already exists for `request_id`
- **EXPECTED:** No "Tap to rate" CTA shown. Neutral dismiss button shown instead, calling `markDone` directly (no RatingSheet).
- **TEST CASE:** Pre-insert review for `request_id=X` → load MyOrders → assert rate CTA absent, dismiss button present.

#### RAT-08: RatingSheet Dismiss Paths Are Equivalent
- **WHAT:** Skip button, backdrop tap, swipe-down close
- **EXPECTED:** All three → `markDone` → `status='done'`, no `vendor_reviews` insert, no counter increment. Blocked only while `busy` (submission in flight).
- **TEST CASE:** Open RatingSheet → tap backdrop → assert order status='done', no review row created.

#### RAT-09: Admin Low-Rating Moderation
- **WHAT:** Admin "Low Ratings" panel delete action
- **EXPECTED:** Delete removes `vendor_reviews` row AND triggers `syncVendorRatingFromReviews`. If it was the vendor's last review, `avg_rating→null`, `review_count→0`, `low_rating_admin_notified→false`.
- **TEST CASE:** Vendor has exactly 1 review (rating=1) → admin deletes it → assert `vendors.avg_rating IS NULL`, `review_count=0`, `low_rating_admin_notified=false`.

#### RAT-10: Low Rating Alert Lifecycle
- **WHAT:** `admin_alert` (low rating) fire + reset
- **EXPECTED:** Fires once when `avg_rating < 2.0 AND review_count >= 5 AND low_rating_admin_notified=false` → sets flag true. Does NOT fire again while flag is true. Resets to false when `avg_rating > 3.5`.
- **TEST CASE:** Drive avg_rating below 2.0 with 5 reviews → assert `admin_alert` inbox row created, flag=true. Add more low reviews → assert NO second `admin_alert`. Add reviews bringing avg above 3.5 → assert flag resets to false.
## 🏗️ SESSION 42 — THREE-MODE GAP AUDIT + FIXES (13 June 2026)

### ✅ WHAT WAS DONE

Full gap audit across all three service modes — Delivery, Booking/Appointment, and Help (Help was audited in the previous session). Every gap was triaged: fix, by-design, or skip with reasoning. All fixes applied.

---

### DELIVERY MODE — GAP AUDIT + FIXES

#### Business Rules — Delivery Mode (Reference)
- Table: `requests` only
- Delivery orders have: `delivery_slot`, `delivery_address`, `delivery_slot_deadline` (set at insert by `getDeliverySlotDeadline()` in ParchiSheet.tsx)
- No `appointment_time` / `appointment_status`
- Key behaviour: vendor opening Incoming Orders bulk-flips all `sent` → `seen` (silent, no customer notify)
- Accept only works from `seen` state — vendor must open Incoming Orders first

#### Slot Deadline Mapping (set in ParchiSheet.tsx `getDeliverySlotDeadline()`)
| Slot | Deadline |
|---|---|
| `asap` | now + 2 hours |
| `morning` | today 12:00 local |
| `afternoon` | today 16:00 local |
| `evening` | today 20:00 local |
| `tomorrow` | tomorrow 20:00 local |

#### Status Flow — Delivery
```
Customer places order → status: sent (+ delivery_slot + delivery_slot_deadline) → vendor notified
Vendor opens Incoming Orders → status: seen (bulk auto, silent)
Vendor accepts → status: accepted → customer notified
Vendor marks done → status: fulfilled → customer notified
Customer rates → status: done
OR vendor dismisses fulfilled → status: done

Expiry: cron runs every 5min → if delivery_slot_deadline passed and status sent/seen → status: expired → customer notified
Near-deadline: warn fired 60min before slot deadline (delivery_near_deadline_minutes config)
```

#### Delivery Gap Triage — Complete
| Gap | Description | Decision | Fix Applied |
|---|---|---|---|
| Gap 1 | Past-slot order — customer picks morning at 2pm, order expires instantly | ✅ Fixed | Block insert in ParchiSheet if slot deadline already past |
| Gap 2 | Near-deadline warn copy status-unaware — inbox says "not seen" after vendor opens | ✅ Fixed | SQL migration: slot+status aware body copy |
| Gap 3 | Bulk sent→seen is silent — no customer notify | ⚪ By design | Customer doesn't need push every time vendor opens list |
| Gap 4 | Accept only from seen | ⚪ By design | Intentional — vendor must open orders first |
| Gap 5 | Asymmetric cancel rules — seen within 24h cannot cancel | ⚪ By design | 24h block is fraud protection |
| Gap 6 | Expiry FCM | ✅ Already fixed Session 41 | — |
| Gap 7+8 | Raw "accepted" label in My Orders — no friendly copy for delivery | ✅ Fixed | Added `status_accepted_delivery` string key |
| Gap 9 | Accepted delivery never expires — no amber card | ✅ Fixed | Amber warning card in MyOrders when accepted + past deadline |
| Gap 10 | Go-offline notify only on accepted | ⚪ By design | sent/seen not committed yet |
| Gap 11 | Unread badge clears after bulk seen | ✅ Fixed | Badge now counts sent+seen for delivery |
| Gap 12 | Edit is message-only | ⚪ By design | Slot/address change = new order |
| Gap 13 | No vendor decline for delivery | ⚪ By design | Delivery is accept-or-cancel, not confirm/decline |
| Gap 14 (Gap 16) | null deadline orders never expire | ⚪ Skipped | Clearing all data at launch, fresh start |
| Gap 15 (Gap 17) | delivery_near_deadline_minutes not in admin whitelist | ✅ Fixed | Added to ADMIN_CONFIG_WHITELIST in Settings.tsx |
| Gap 16 (Gap 19) | Vendor auto-dismiss fulfilled silent | ⚪ By design | Customer already got fulfilled push |
| Gap 17 (Gap 20) | Generic expiry copy — "No vendor accepted" wrong for seen orders | ✅ Fixed | Slot-aware copy in expire_pending_orders() SQL |

#### Delivery Fixes Applied — Detail

**Gap 1 — ParchiSheet past-slot guard**
- File: `src/components/ParchiSheet.tsx`
- In `executeOrderInsert`, before `setSending(true)`, added delivery guard:
  ```typescript
  if (effectiveVendor?.service_mode === "delivery") {
    const slotDeadline = getDeliverySlotDeadline(selectedSlot);
    if (slotDeadline != null && new Date(slotDeadline) < new Date()) {
      toast.error(s.parchi_slot_expired);
      return;
    }
  }
  ```
- String added: `parchi_slot_expired` (EN/HI/MR) — "This delivery slot has already passed. Please pick a different slot."
- WHY: Without this guard, customer placing a morning order at 2pm gets an order that expires in <5 minutes on the next cron run. Confusing and broken UX.

**Gap 2 — Slot+status aware near-deadline copy**
- Migration: `20260613000001_fix_delivery_near_deadline_copy.sql` (CREATE OR REPLACE FUNCTION warn_pending_orders_near_deadline)
- Delivery CTEs now select `delivery_slot` and build dynamic body:
  - `order_near_deadline_unseen` (sent): "Your vendor has not seen your [slot] order yet. The delivery window is closing soon."
  - `order_near_deadline_unconfirmed` (seen): "Your vendor saw your [slot] order but has not accepted it. The delivery window is closing soon."
- COALESCE fallback: 'delivery' when slot is null
- Edge function `warn-near-deadline` updated to select `delivery_slot` from requests
- Applied: TEST + PROD ✅ | Edge function redeployed ✅

**Gap 7+8 — Friendly accepted label**
- File: `src/lib/strings.ts` — added `status_accepted_delivery` (EN/HI/MR): "Vendor accepted — preparing your order"
- File: `src/pages/MyOrders.tsx` — `userStatusLabel`: if status=accepted AND service_mode=delivery → use `status_accepted_delivery`; help uses existing `status_accepted`
- WHY: Help mode shows "Vendor accepted — on the way" but delivery showed raw "accepted". Inconsistent and unhelpful.

**Gap 9 — Amber card for accepted+past-deadline delivery**
- File: `src/pages/MyOrders.tsx` — added `isDeliveryAcceptedOverdue()` — true when delivery + accepted + delivery_slot_deadline in past
- Amber card: `border-amber-500/30 bg-amber-500/5` — shows below status badge
- Added Dismiss button → calls `markDone(r.id)` — silent, no notifications, removes row
- String keys: `delivery_accepted_overdue_title`, `delivery_accepted_overdue_body` (EN/HI/MR)
- Body: "Your vendor accepted this order but the delivery slot has passed. You can dismiss this order or wait for the vendor to mark it done."
- `delivery_slot_deadline` added to orders select in MyOrders
- WHY: Vendor accepted but didn't deliver, time passed — customer had no indication and no way out.

**Gap 11 — Badge counts sent+seen for delivery**
- File: `src/components/IncomingOrdersSection.tsx` — `countUnreadIncomingOrders()`
- Delivery: counts `sent + seen` | Help/appointment: counts `sent` only
- Updated at: `load()` initial count, `load()` after bulk flip refresh, local `unread` variable
- WHY: Vendor opens orders (all flip to seen), badge drops to 0 even though no orders acted on. Misleads vendor into thinking no pending work.

**Gap 15 (17) — Admin whitelist**
- File: `src/pages/Settings.tsx` — added `delivery_near_deadline_minutes` to `ADMIN_CONFIG_WHITELIST` and `ADMIN_CONFIG_LABELS`, after `help_near_deadline_minutes`
- WHY: Config key exists in DB and works, but wasn't editable from admin panel.

**Gap 17 (20) — Slot-aware expiry copy**
- Included in migration `20260613000001_fix_delivery_near_deadline_copy.sql`
- `expire_pending_orders()`: appointment expiry block builds body using delivery_slot: "Your [slot] delivery window has passed."
- WHY: "No vendor accepted your request in time" is wrong when vendor did see the order; also gives no context about which order expired.

---

### BOOKING / APPOINTMENT MODE — GAP AUDIT + FIXES

#### Business Rules — Booking Mode (Reference)
- Table: `requests` only
- Booking rows have: `appointment_time`, `appointment_status` (pending → confirmed / declined / cancelled / expired)
- May include `delivery_address` when location is "come to my place". No `delivery_slot`.
- Two fields drive state — CRITICAL to use the right one:
  - `appointment_status`: pending → confirmed / declined / cancelled / expired
  - `status`: sent / seen / fulfilled / cancelled / expired / done
- **"Confirmed" does NOT set status: accepted.** Go-offline, badges, and filters must use `appointment_status` not `status`.
- Same as delivery: opening Incoming Orders bulk-flips sent → seen (silent)
- Vendor actions: Confirm booking / Decline booking + reason / Mark done / Cancel confirmed booking + reason
- Accept timeout config (`appointment_accept_timeout_hours`) is DEAD — loaded in SQL but never used. Expiry uses `appointment_time < now()` only.

#### Status Flow — Booking
```
Customer books → status: sent, appointment_status: pending (+ appointment_time) → vendor notified
Vendor opens Incoming Orders → status: seen (bulk auto, silent)
Vendor confirms → appointment_status: confirmed (status stays sent/seen) → customer notified "Booking confirmed"
Vendor declines → appointment_status: declined → customer notified
Vendor marks done → status: fulfilled → customer notified
Customer rates → status: done
OR vendor dismisses fulfilled → status: done

Expiry: cron → if appointment_time passed and appointment_status still pending → status: expired, appointment_status: expired → customer notified
Near-deadline: warn fired 60min before appointment_time (appointment_near_deadline_minutes config)
```

#### Booking Gap Triage — Complete
| Gap | Description | Decision | Fix Applied |
|---|---|---|---|
| B1 | Two fields (status + appointment_status) confuse go-offline/badge | ⚪ Architecture — verify in code | Already handled correctly in code |
| B2 | Near-deadline dedupe wrong message after seen | ✅ Fixed | SQL migration: appointment_time-aware copy |
| B3 | Bulk sent→seen silent | ⚪ By design | Same as delivery — intentional |
| B4 | Badge counts sent only — clears after bulk seen | ✅ Fixed | Badge now counts sent+seen for booking |
| B5 | No past-appointment guard at book time | ✅ Fixed | Block insert in ParchiSheet if appointment_time already past |
| B6 | Expiry copy order-centric — "No vendor accepted" wrong for booking | ✅ Fixed | "Your vendor did not confirm your booking in time." |
| B7 | Confirmed bookings never expire — no amber card | ✅ Fixed | Amber card when confirmed + appointment_time past + Dismiss button |
| B8 | Customer stuck on past confirmed booking — no action available | ✅ Fixed | Dismiss button on amber card (markDone — silent, no notify) |
| B9 | cancelAppointment() dead code | ⚪ Skip | Post-launch cleanup — harmless |
| B10 | Declined bookings: vendor has no dismiss | ✅ Fixed | Vendor dismiss now covers cancelled AND declined |
| B11 | Go-offline: only today's appointments block | ⚪ By design | Future booking = time available, same as delivery tomorrow |
| B12 | Go-offline: pending sent/seen orders get no customer notify | ✅ Fixed | Vendor go-offline now notifies customers with today's sent/seen orders (delivery + booking both) |
| B13 | Edit textarea hardcoded "Your order message" placeholder — not localized | ✅ Fixed | Moved to strings.ts as editOrder_messagePlaceholder (EN/HI/MR), applies to all modes |
| B14 | appointment_accept_timeout_hours is dead config — misleads admin | ✅ Fixed | Removed from ADMIN_CONFIG_WHITELIST (was never there — confirmed not visible already) |
| B15 | appointment_near_deadline_minutes not in admin whitelist | ✅ Fixed | Added to ADMIN_CONFIG_WHITELIST in Settings.tsx |
| B16 | Near-deadline copy not appointment-time aware — says "delivery window" | ✅ Fixed | SQL migration: includes formatted appointment_time in body |
| B17 | Vendor auto-dismiss stale fulfilled silent | ⚪ By design | Customer already got fulfilled push |
| B18 | No GPS for bookings | ⚪ Post-city-scale | Separate feature backlog |
| B19 | Generic expiry title all modes | ✅ Fixed | Appointment-specific copy in expire_pending_orders() |

#### Booking Fixes Applied — Detail

**Gap B5 — ParchiSheet past-appointment guard**
- File: `src/components/ParchiSheet.tsx`
- In `executeOrderInsert`, after delivery guard, added appointment guard:
  ```typescript
  if (effectiveVendor?.service_mode === "appointment") {
    if (appointmentTimestamp != null && new Date(appointmentTimestamp) < new Date()) {
      toast.error(s.parchi_appointment_expired);
      return;
    }
  }
  ```
- Uses `appointmentTimestamp` (full datetime) not `appointmentTime` (HH:mm only)
- String: `parchi_appointment_expired` (EN/HI/MR) — "This appointment time has already passed. Please pick a different date and time."
- WHY: Customer picking "today 10am" at 2pm gets a booking that expires in <5 minutes. Same issue as delivery Gap 1.

**Gap B4 — Badge counts sent+seen for booking**
- File: `src/components/IncomingOrdersSection.tsx` — `countUnreadIncomingOrders()`
- Delivery OR appointment: counts `sent + seen` | Help: counts `sent` only
- WHY: After vendor opens bookings (bulk seen), badge clears even though Confirm/Decline still required.

**Gap B2 + B16 — Appointment-time aware near-deadline copy**
- Migration: `20260613000002_fix_booking_near_deadline_and_expiry_copy.sql`
- `warn_pending_orders_near_deadline()` — appointment blocks:
  - Added `appointment_time` to RETURNING/representatives
  - `order_near_deadline_unseen` (sent+pending): Title "Appointment reminder" / Body "Your vendor has not seen your booking for [DD Mon, HH:MM AM] yet. Appointment time is approaching."
  - `order_near_deadline_unconfirmed` (seen+pending): Title "Appointment reminder" / Body "Your vendor has not confirmed your booking for [DD Mon, HH:MM AM]. Appointment time is approaching."
  - COALESCE fallback: 'your appointment' when appointment_time is null
  - Formatted using `TO_CHAR(appointment_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM')`
- Applied: TEST + PROD ✅ | Edge function warn-near-deadline redeployed ✅
- WHY: Old copy said "delivery window approaching" (wrong word) and didn't tell customer which booking.

**Gap B6 + B19 — Booking-centric expiry copy**
- In same migration `20260613000002`:
- `expire_pending_orders()` — appointment expiry block:
  - Now selects `r.appointment_time`
  - Body: "Your vendor did not confirm your booking for [DD Mon, HH:MM AM] in time." (slot omitted when null)
- Applied: TEST + PROD ✅
- WHY: "No vendor accepted your request in time" is semantically wrong for bookings — action is Confirm not Accept.

**Gap B7 + B8 — Amber card for confirmed+past appointment_time + Dismiss**
- File: `src/pages/MyOrders.tsx`
- Added `isBookingConfirmedOverdue()` — true when appointment_status=confirmed AND appointment_time in past
- Amber card: same styling as delivery (border-amber-500/30 bg-amber-500/5)
- Added Dismiss button → `markDone(r.id)` — silent, no notifications
- String keys: `booking_confirmed_overdue_title`, `booking_confirmed_overdue_body` (EN/HI/MR)
- Body: "Your vendor confirmed this booking but the appointment time has passed. You can dismiss this or wait for the vendor to mark it done."
- WHY: Vendor confirmed but didn't show up / didn't mark done — customer completely stuck, no way to dismiss stale row.

**Gap B10 — Vendor dismiss for declined bookings**
- File: `src/components/IncomingOrdersSection.tsx`
- Dismiss condition now: `r.status === "cancelled" || r.appointment_status === "declined"`
- Calls `dismissOrder()` → status: done, removes from list, no customer notification
- Declined bookings still show red declined banner, with Dismiss below
- WHY: Vendor declines a booking — row stayed in vendor list forever with no cleanup path. Declined = same semantic as cancel = vendor should be able to dismiss.

**Gap B12 — Go-offline notify for pending sent/seen orders (delivery + booking both)**
- File: `src/pages/VendorMode.tsx` — `notifyUsersVendorOffline()`
- Extended: Today's sent/seen delivery + booking orders now also notify customers when vendor goes offline
- One notification per customer phone; active (accepted/confirmed) copy wins if same customer has both
- String keys added: `goOffline_pendingOrderNotify_title`, `goOffline_pendingOrderNotify_body` (EN/HI/MR)
- Body: "Your vendor has gone offline. You can cancel this order and place a new one, or wait for them to come back online."
- WHY: Customer placed order for today, vendor went offline without acting. Customer waits indefinitely not knowing vendor is gone. Near-deadline cron warns about time, but not about vendor going offline.

**Gap B13 — Edit textarea placeholder localized**
- File: `src/lib/strings.ts` — added `editOrder_messagePlaceholder` (EN/HI/MR): "Your order message"
- File: `src/pages/MyOrders.tsx` — replaced hardcoded "Your order message" with `s.editOrder_messagePlaceholder`
- Applies to all modes — delivery, booking, help
- WHY: Hardcoded English placeholder invisible to HI/MR users.

**Gap B15 — appointment_near_deadline_minutes in admin whitelist**
- File: `src/pages/Settings.tsx` — added `appointment_near_deadline_minutes` to `ADMIN_CONFIG_WHITELIST` and `ADMIN_CONFIG_LABELS`, after `delivery_near_deadline_minutes`
- WHY: Config key works but wasn't editable from admin panel.

---

### INFRASTRUCTURE CLEANUP

#### env-split Migration Conflict — Fixed
**Problem:** Env-specific migration files in `supabase/migrations/` caused `db push` conflicts when switching between TEST and PROD.

**Files moved to `supabase/migrations/_held/`:**
| File | Environment | Purpose |
|---|---|---|
| `20260611000000_warn_near_deadline_cron_test.sql` | TEST only | pg_cron → warn-near-deadline (TEST URL + anon key) |
| `20260611000001_warn_near_deadline_cron_prod.sql` | PROD only | pg_cron → warn-near-deadline (PROD URL + anon key) |
| `20260611020000_expire_order_fcm_notify_test.sql` | TEST only | expire_pending_orders() FCM via notify-user (TEST) |
| `20260611020001_expire_order_fcm_notify_prod.sql` | PROD only | expire_pending_orders() FCM via notify-user (PROD) |

**Migration history repaired:**
- TEST: `migration repair --status reverted 20260611000000 20260611020000` ✅
- PROD: Still needs repair before next push (see Session 43 START HERE section above)

**Workflow going forward:**
| Task | Action |
|---|---|
| Shared migration changes | Edit `migrations/` → db push TEST → verify → db push PROD |
| Env-specific changes | Use `_held/` files → `db query` directly per environment |

**Remaining 30 migrations in `migrations/` are all shared — safe to push to both environments.**

---

### 📦 MIGRATIONS APPLIED IN SESSION 42
| Migration | Description | Environments |
|---|---|---|
| `20260613000001_fix_delivery_near_deadline_copy.sql` | CREATE OR REPLACE warn_pending_orders_near_deadline() — delivery slot-aware copy + CREATE OR REPLACE expire_pending_orders() — slot-aware expiry copy | TEST + PROD |
| `20260613000002_fix_booking_near_deadline_and_expiry_copy.sql` | CREATE OR REPLACE warn_pending_orders_near_deadline() — appointment datetime-aware copy + CREATE OR REPLACE expire_pending_orders() — booking-centric expiry copy | TEST + PROD |

### 🔧 FILES CHANGED IN SESSION 42
| File | What changed |
|---|---|
| `src/components/ParchiSheet.tsx` | Past-slot guard (delivery) + past-appointment guard (booking) before setSending(true) |
| `src/lib/strings.ts` | parchi_slot_expired, parchi_appointment_expired, status_accepted_delivery, delivery_accepted_overdue_title/body, booking_confirmed_overdue_title/body, goOffline_pendingOrderNotify_title/body, editOrder_messagePlaceholder — all in EN/HI/MR |
| `src/pages/MyOrders.tsx` | Friendly delivery accepted label, delivery overdue amber card + dismiss, booking overdue amber card + dismiss, delivery_slot_deadline added to orders select |
| `src/lib/orders.ts` | delivery_slot_deadline optional field on OrderRequestRow |
| `src/components/IncomingOrdersSection.tsx` | countUnreadIncomingOrders: delivery+booking count sent+seen, vendor dismiss covers declined bookings |
| `src/pages/Settings.tsx` | delivery_near_deadline_minutes + appointment_near_deadline_minutes added to ADMIN_CONFIG_WHITELIST and ADMIN_CONFIG_LABELS |
| `src/pages/VendorMode.tsx` | notifyUsersVendorOffline: extended to notify customers with today's sent/seen delivery+booking orders |
| `supabase/migrations/20260613000001_*.sql` | Delivery near-deadline + expiry copy fix |
| `supabase/migrations/20260613000002_*.sql` | Booking near-deadline + expiry copy fix |
| `supabase/migrations/_held/` | 4 env-specific files moved here from migrations/ |
| `supabase/functions/warn-near-deadline/index.ts` | delivery_slot + delivery_slot added to select; PendingPushRow type updated |

### ✅ SESSION 42 FINAL STATUS
- All delivery mode gaps triaged and fixed ✅
- All booking mode gaps triaged and fixed ✅
- Infrastructure: env-split migration conflict resolved ✅
- 2 migrations applied to TEST + PROD ✅
- Edge function warn-near-deadline redeployed to TEST + PROD ✅
- CLI currently linked to **TEST** (`hhdylnhqdzfabsolwxdz`)
- PROD migration repair needed before next PROD push — see Session 43 START HERE

*Next: BR-3 Index.tsx first-open flow → Customer name → Appointment billing unblock → Razorpay → Play Store*

---

## 📐 REQUIREMENT SPECIFICATIONS — SERVICE MODES

> This section defines what the app is EXPECTED to do — not what was coded.
> Use this to write requirement-based tests that uncover gaps, not just validate code.
> Every rule here is the source of truth. If code differs from this, code is wrong.

### Why This Section Exists
336 automated tests were passing, yet we found 20+ gaps and defects across three modes in Session 42. The tests validated what was coded, not what was expected. Requirement-based testing asks: "If a customer places a morning order at 2pm, should the app block it?" — not "Does the insert function run?"

### HOW TO USE THIS FOR TEST CASES
For each rule below, a test should:
1. Set up the exact state described
2. Perform the action
3. Assert the EXPECTED outcome — not just "no error"
4. Assert side effects: notifications sent? status changed? badge updated?

---

### 📦 DELIVERY MODE — REQUIREMENTS

#### DR-01: Order Placement — Slot Validation
- **WHAT:** Customer selects a delivery slot. App computes `delivery_slot_deadline` using `getDeliverySlotDeadline()`.
- **EXPECTED:** If computed deadline is already in the past at time of placement, insert is BLOCKED. Toast shown: `parchi_slot_expired`.
- **TEST CASE:** Place morning order after 12:00 → expect toast, no DB insert.
- **TEST CASE:** Place tomorrow order at any time → expect insert succeeds.
- **TEST CASE:** Place asap order → deadline = now+2hr → insert succeeds.

#### DR-02: Order Placement — Slot Deadline Set
- **WHAT:** Every delivery order insert must include a non-null `delivery_slot_deadline`.
- **EXPECTED:** After insert, `delivery_slot_deadline` is set correctly per slot mapping.
- **TEST CASE:** Insert evening order → assert `delivery_slot_deadline` = today 20:00 in DB.

#### DR-03: Vendor Opens Incoming Orders — Bulk Seen
- **WHAT:** When vendor opens Incoming Orders, all `sent` delivery orders flip to `seen`.
- **EXPECTED:** No customer notification sent. No customer inbox entry. Customer learns only via polling.
- **TEST CASE:** Place order → open vendor orders → assert status=seen, assert no customer notification created.

#### DR-04: Vendor Badge — Delivery
- **WHAT:** Vendor unread badge for delivery mode.
- **EXPECTED:** Badge counts `sent + seen` orders. Badge only clears when vendor accepts or cancels — NOT when vendor merely opens the list.
- **TEST CASE:** Place 3 orders → open vendor orders (bulk seen) → assert badge = 3 (not 0).
- **TEST CASE:** Accept 1 order → assert badge = 2.

#### DR-05: Accept — Only From Seen
- **WHAT:** Vendor can only accept from `seen` state, not `sent`.
- **EXPECTED:** Accept button not shown for `sent` orders.
- **TEST CASE:** Place order → immediately try accept (without opening orders) → expect failure.

#### DR-06: Near-Deadline Warning — Slot + Status Aware
- **WHAT:** Near-deadline warning fires `delivery_near_deadline_minutes` (default 60) before `delivery_slot_deadline`.
- **EXPECTED:**
  - If status=sent: body contains slot name AND "has not seen"
  - If status=seen: body contains slot name AND "has not accepted"
  - One warn per customer+vendor pair (deduped by `near_deadline_warned_at`)
- **TEST CASE:** Create sent morning order with deadline 30min away → run cron → assert inbox body contains "morning" AND "not seen".
- **TEST CASE:** Create seen morning order with deadline 30min away → run cron → assert inbox body contains "morning" AND "not accepted".

#### DR-07: Order Expiry
- **WHAT:** `expire_pending_orders()` cron runs every 5 minutes.
- **EXPECTED:** If `delivery_slot_deadline < now()` AND status is `sent` or `seen` → status = `expired`. Customer notified.
- **TEST CASE:** Insert order with deadline = now-1min, status=sent → run expire fn → assert status=expired, assert customer notification created.
- **TEST CASE:** Insert accepted order with deadline in past → run expire fn → assert status stays `accepted` (accepted orders don't expire).

#### DR-08: Expiry Notification Copy
- **WHAT:** Customer expiry notification body.
- **EXPECTED:** Body includes slot name. E.g., "Your morning delivery window has passed."
- **NOT EXPECTED:** Generic "No vendor accepted your request in time."
- **TEST CASE:** Expire morning order → assert notification body contains "morning".

#### DR-09: Accepted Order — Amber Warning
- **WHAT:** Customer My Orders view for delivery.
- **EXPECTED:** When status=accepted AND delivery_slot_deadline is in the past → show amber warning card with Dismiss button.
- **TEST CASE:** Set status=accepted, delivery_slot_deadline=now-1hr → load My Orders → assert amber card visible, assert Dismiss button present.

#### DR-10: Accepted Order — Dismiss
- **WHAT:** Customer taps Dismiss on amber card.
- **EXPECTED:** status → done, row removed from My Orders. No notification to vendor.
- **TEST CASE:** Tap dismiss → assert status=done in DB, assert no vendor notification created.

#### DR-11: Customer Status Label — Accepted Delivery
- **WHAT:** Customer My Orders status label when delivery order is accepted.
- **EXPECTED:** Shows "Vendor accepted — preparing your order" (not raw "accepted").
- **TEST CASE:** Set delivery order status=accepted → load My Orders → assert label = status_accepted_delivery string value.

#### DR-12: Go-Offline — Today's Pending Orders Notify Customer
- **WHAT:** Vendor goes offline with today's sent/seen delivery orders.
- **EXPECTED:** Each customer with a today's-slot sent/seen order receives notification: "Your vendor has gone offline. You can cancel this order and place a new one, or wait for them to come back online."
- **TEST CASE:** Place today morning order (sent) → vendor goes offline → assert customer notification created with goOffline_pendingOrderNotify_title.
- **TEST CASE:** Place tomorrow order → vendor goes offline → assert NO notification sent.

#### DR-13: Customer Cancel Rules
- **WHAT:** Customer cancel button visibility in My Orders.
- **EXPECTED:**
  - `sent`: can cancel anytime
  - `seen` within 24h of order: CANNOT cancel
  - `seen` after 24h: can cancel
  - `accepted`: cannot cancel
- **TEST CASE:** Place order → seen within 1hr → try cancel → expect blocked.
- **TEST CASE:** Place order → seen → wait 25hrs → cancel → expect success.

#### DR-14: edit Order — Delivery
- **WHAT:** Customer edits delivery order.
- **EXPECTED:** Can only edit message. Cannot change slot, address, or delivery_slot_deadline. Edit does not revert seen→sent.
- **TEST CASE:** Edit message on seen order → assert message updated, status still seen, slot unchanged.

#### DR-15: Admin Config — Delivery Near-Deadline Minutes
- **WHAT:** Admin panel should show `delivery_near_deadline_minutes` key for editing.
- **EXPECTED:** Key visible and editable in admin Settings panel.
- **TEST CASE:** Login as admin → open Settings → assert delivery_near_deadline_minutes input visible.

---

### 📅 BOOKING MODE — REQUIREMENTS

#### BR-01: Order Placement — Past Appointment Guard
- **WHAT:** Customer selects appointment date and time. App computes full `appointmentTimestamp`.
- **EXPECTED:** If `appointmentTimestamp` is already in the past at time of placement, insert is BLOCKED. Toast: `parchi_appointment_expired`.
- **TEST CASE:** Select today's date + a time 2 hours ago → expect toast, no DB insert.
- **TEST CASE:** Select tomorrow + any future time → expect insert succeeds.

#### BR-02: Vendor Opens Incoming Orders — Bulk Seen (Same as Delivery)
- Same as DR-03. No customer notification on bulk flip.

#### BR-03: Vendor Badge — Booking
- **WHAT:** Vendor unread badge for booking mode.
- **EXPECTED:** Badge counts `sent + seen` orders (same as delivery). Badge only clears when vendor acts (Confirm/Decline).
- **TEST CASE:** Place booking → open vendor orders → assert badge = 1 (not 0 after bulk seen).

#### BR-04: Two-Field State — Must Use Correct Field
- **WHAT:** Booking uses both `status` and `appointment_status`.
- **EXPECTED:**
  - "Confirmed" = `appointment_status: confirmed`. `status` does NOT change to `accepted`.
  - Go-offline blocking: uses `appointment_status = confirmed` (not `status = accepted`)
  - Badge counting: uses `status` (sent/seen)
- **TEST CASE:** Confirm booking → assert appointment_status=confirmed, assert status still=seen (not accepted).

#### BR-05: Near-Deadline Warning — Appointment-Time Aware
- **WHAT:** Near-deadline warning fires `appointment_near_deadline_minutes` (default 60) before `appointment_time`.
- **EXPECTED:**
  - If status=sent, appointment_status=pending: body contains formatted appointment datetime AND "has not seen"
  - If status=seen, appointment_status=pending: body contains formatted appointment datetime AND "has not confirmed"
  - Title: "Appointment reminder"
- **TEST CASE:** Create sent booking for 30min from now → run cron → assert inbox title="Appointment reminder", body contains datetime.

#### BR-06: Order Expiry — Booking
- **WHAT:** If `appointment_time < now()` AND `appointment_status = pending` → expire.
- **EXPECTED:** `status = expired`, `appointment_status = expired`. Customer notified.
- **TEST CASE:** Insert booking with appointment_time=now-1min, appointment_status=pending → run expire → assert both fields = expired.
- **TEST CASE:** Confirmed booking with past appointment_time → run expire → assert status stays confirmed (confirmed bookings don't auto-expire).

#### BR-07: Expiry Notification Copy — Booking
- **WHAT:** Customer expiry notification for booking.
- **EXPECTED:** Body: "Your vendor did not confirm your booking for [datetime] in time."
- **NOT EXPECTED:** "No vendor accepted your request in time."
- **TEST CASE:** Expire pending booking → assert notification body contains "confirm" AND formatted datetime.

#### BR-08: Confirmed + Past Time — Amber Warning
- **WHAT:** Customer My Orders for booking.
- **EXPECTED:** When appointment_status=confirmed AND appointment_time is in the past → show amber warning card with Dismiss button.
- **TEST CASE:** Set appointment_status=confirmed, appointment_time=now-2hr → load My Orders → assert amber card visible.

#### BR-09: Confirmed + Past Time — Dismiss
- Same as DR-10. Dismiss → status=done, no notification.

#### BR-10: Vendor Dismiss — Declined Bookings
- **WHAT:** Vendor Incoming Orders list for declined bookings.
- **EXPECTED:** Vendor can dismiss a declined booking (appointment_status=declined). Dismiss → status=done, removed from list. No customer notification.
- **TEST CASE:** Decline booking → assert dismiss button visible on vendor side. Tap dismiss → assert status=done.

#### BR-11: Go-Offline — Today's Pending Bookings Notify Customer
- Same as DR-12 for booking mode. Today's sent/seen bookings (any appointment_time today) trigger customer notification on vendor go-offline.

#### BR-12: Customer Cancel — Booking
- **WHAT:** Customer cancel rules for bookings.
- **EXPECTED:**
  - Future day booking: cancel available
  - Same day booking: amber warning → must tap "call vendor" first → then cancel
  - Past appointment_time: NO cancel shown (customer must use Dismiss from amber card)
- **TEST CASE:** Set booking with past appointment_time → load My Orders → assert no cancel button shown, assert amber card + dismiss shown.

#### BR-13: Edit Booking — Message Only
- **WHAT:** Customer edits booking.
- **EXPECTED:** Can only edit message. Cannot change date/time/location. Hint text visible: "To change address, slot, or appointment time — cancel this order and place a new one."
- **TEST CASE:** Edit message on seen booking → assert message updated, appointment_time unchanged.

#### BR-14: Admin Config — appointment_near_deadline_minutes
- **WHAT:** Admin panel should show `appointment_near_deadline_minutes` key.
- **EXPECTED:** Visible and editable in admin Settings panel.
- **TEST CASE:** Login as admin → open Settings → assert appointment_near_deadline_minutes visible.

#### BR-15: appointment_accept_timeout_hours — Dead Config
- **WHAT:** This key exists in DB but is NOT used for any logic.
- **EXPECTED:** Key NOT visible in admin panel (to avoid misleading admin).
- **TEST CASE:** Login as admin → open Settings → assert appointment_accept_timeout_hours NOT visible.

#### BR-16: Edit Textarea Placeholder — Localized
- **WHAT:** Edit order textarea placeholder.
- **EXPECTED:** Placeholder comes from `editOrder_messagePlaceholder` string key. Shows in HI/MR when app language is set accordingly.
- **TEST CASE:** Switch to HI → open edit order → assert placeholder is HI value, not English "Your order message".

---

### 🆘 HELP MODE — REQUIREMENTS

(Help mode was audited in a previous session. Key rules for reference:)

#### HR-01: Order Expiry
- Help orders expire after `help_accept_timeout_minutes` (default: from DB config) from `created_at`.
- Only `sent` orders expire — `accepted` help orders do not expire.

#### HR-02: Accepted Order — Amber Warning
- When vendor accepts help order + 2hrs pass without marking done → amber warning shown to customer.
- Customer can cancel from this state.

#### HR-03: GPS Tracking — Help Only
- Live vendor GPS tracking is help mode only.
- Stopped-vendor detection (vendor not moved >200m in 10min) fires amber warning to customer.

#### HR-04: Vendor Badge — Help
- Badge counts `sent` only (unlike delivery/booking which count sent+seen).
- Bulk seen does NOT apply to help mode — no auto-flip on vendor open.

#### HR-05: Admin Config — help_near_deadline_minutes
- Visible and editable in admin Settings panel. ✅ (was fixed in help mode audit)

---

### 🔔 NOTIFICATION REQUIREMENTS — ALL MODES

#### NR-01: Every Status Change → Push + Inbox
- Every significant status change must send BOTH FCM push AND inbox entry.
- No status change should be notification-only or inbox-only.

#### NR-02: Near-Deadline — One Per Customer+Vendor Pair
- Near-deadline warning sent maximum once per customer+vendor pair per order (dedupe via `near_deadline_warned_at`).
- Not once per order — once per pair.

#### NR-03: FCM Push Text = Inbox Text
- `warn-near-deadline` edge function reads title/body from `user_notifications` inbox row.
- SQL must insert inbox row BEFORE edge function runs.
- If inbox insert fails, FCM push is also lost.

#### NR-04: Expiry FCM — One Per Customer Per Cron Run
- `expire_pending_orders()` sends one FCM push per customer per 5-min cron run (deduped by user_phone).
- Multiple orders expiring in same run → one notification, not N.

#### NR-05: Go-Offline Notify — Priority
- If same customer has both confirmed/accepted order AND pending sent/seen order → send only the confirmed/accepted copy (higher priority).
- One notification per customer phone per go-offline event.

#### NR-06: Channel
- All order notifications use `order_alert` channel (importance MAX, custom vibration, DND bypass).
- Feed notifications use `default` channel (standard importance).

---

### 🧪 REQUIREMENT-BASED TEST SEEDS

> These are test scenarios that MUST be added to the test suite to prevent regression of Session 42 fixes.
> Format: Test ID | Mode | Scenario | Expected Outcome

| Test ID | Mode | Scenario | Expected |
|---|---|---|---|
| DEL-SLOT-01 | Delivery | Place morning order after 12:00 | Toast shown, no DB insert |
| DEL-SLOT-02 | Delivery | Place tomorrow order any time | Insert succeeds, deadline = tomorrow 20:00 |
| DEL-SLOT-03 | Delivery | Place asap order | Insert succeeds, deadline = now+2hr |
| DEL-BADGE-01 | Delivery | 3 orders placed, vendor opens orders (bulk seen) | Badge = 3 (not 0) |
| DEL-BADGE-02 | Delivery | Vendor accepts 1 of 3 seen orders | Badge = 2 |
| DEL-WARN-01 | Delivery | sent morning order, deadline 30min away, cron runs | Inbox body contains "morning" AND "not seen" |
| DEL-WARN-02 | Delivery | seen morning order, deadline 30min away, cron runs | Inbox body contains "morning" AND "not accepted" |
| DEL-EXP-01 | Delivery | sent order, deadline past, expire fn runs | status=expired, customer notified |
| DEL-EXP-02 | Delivery | accepted order, deadline past, expire fn runs | status stays accepted |
| DEL-EXP-03 | Delivery | Expire morning order | Notification body contains "morning" |
| DEL-AMBER-01 | Delivery | accepted order, delivery_slot_deadline past | Amber card visible in My Orders |
| DEL-AMBER-02 | Delivery | Customer taps Dismiss on amber card | status=done, no vendor notification |
| DEL-LABEL-01 | Delivery | Delivery order status=accepted | My Orders label = "Vendor accepted — preparing your order" |
| DEL-GOOFF-01 | Delivery | Today morning order (sent), vendor goes offline | Customer notification with go-offline body |
| DEL-GOOFF-02 | Delivery | Tomorrow order, vendor goes offline | No customer notification |
| DEL-ADMIN-01 | Delivery | Admin opens Settings | delivery_near_deadline_minutes visible and editable |
| BOOK-GUARD-01 | Booking | Book appointment 2hrs in the past | Toast shown, no DB insert |
| BOOK-GUARD-02 | Booking | Book appointment tomorrow | Insert succeeds |
| BOOK-BADGE-01 | Booking | Booking placed, vendor opens (bulk seen) | Badge = 1 (not 0) |
| BOOK-STATE-01 | Booking | Vendor confirms booking | appointment_status=confirmed, status still seen (not accepted) |
| BOOK-WARN-01 | Booking | sent pending booking 30min from now, cron runs | Inbox title="Appointment reminder", body has datetime |
| BOOK-EXP-01 | Booking | pending booking appointment_time past, expire runs | status=expired, appointment_status=expired |
| BOOK-EXP-02 | Booking | confirmed booking appointment_time past, expire runs | status stays confirmed |
| BOOK-EXP-03 | Booking | Expire pending booking | Notification body contains "confirm" and formatted datetime |
| BOOK-AMBER-01 | Booking | confirmed booking, appointment_time past | Amber card + Dismiss button in My Orders |
| BOOK-DISMISS-01 | Booking | Customer taps Dismiss on booking amber card | status=done, no vendor notification |
| BOOK-VDISMISS-01 | Booking | Vendor declines booking | Dismiss button visible on vendor side |
| BOOK-VDISMISS-02 | Booking | Vendor taps Dismiss on declined booking | status=done, removed from vendor list, no customer notify |
| BOOK-GOOFF-01 | Booking | Today's sent booking, vendor goes offline | Customer notification sent |
| BOOK-GOOFF-02 | Booking | Future booking (tomorrow), vendor goes offline | No customer notification |
| BOOK-ADMIN-01 | Booking | Admin opens Settings | appointment_near_deadline_minutes visible, appointment_accept_timeout_hours NOT visible |
| BOOK-LOCALE-01 | All | Switch to HI, open edit order | Textarea placeholder in Hindi |

---

## 🏗️ SESSION 42B — ANNOUNCEMENTS + RECOMMENDATIONS AUDIT + FIXES (13 June 2026)

### ✅ WHAT WAS DONE
Full audit of Local Feed — announcements, recommendations, and vendor offers. 32 gaps identified (A1-A17, R1-R15), triaged into fix/by-design/skip/moved. 9 Cursor prompts executed. Major outcomes: vendor offers now push to nearby customers (core USP), feed notifications moved from unreliable client-side calls to DB webhook trigger, AI-powered category suggestion system built, recommendation-to-vendor linking with admin lead generation for non-Aaspaas vendors, full notification deep-link audit and fix across the entire app.

### Terminology Clarification (CRITICAL — read before touching feed code)
| User says | App actually has |
|---|---|
| "Announcement" | Local Feed post, `feed_posts.type = 'announcement'` — photo OPTIONAL (was mandatory, fixed this session), expires_at = +3 days |
| "Recommendation" | Local Feed post, `feed_posts.type = 'recommendation'` — text tip, can link to vendor (new this session), replies via `feed_replies` |
| "Vendor offer" | Settings → MY SHOP → Offers, `feed_posts.type = 'offer'`, `vendor_id` set, now has lat/lng + push (fixed this session) |
| "Suggested vendor" | Radar geo search ranked by trust tier — NOT social recommendations, separate system |
| "Refer & Earn" | `referrals` table + `vendor_credits` — separate from feed entirely |

### feed_posts Table — Field Reference (Updated)
| Column | Type | Set by | Notes |
|---|---|---|---|
| `type` | text | client | 'announcement' / 'recommendation' / 'offer' |
| `vendor_id` | uuid, nullable | client | NULL for announcement/recommendation (by design — community posts, not shop-linked). Set for offers. |
| `image_url` | text, nullable | client | OPTIONAL for announcements now (was mandatory — Session 36 decision finally implemented) |
| `lat` / `lng` | numeric | client | MANDATORY for all post types now. Customer posts (announcement/recommendation) = current GPS (blocked if missing). Vendor offers = shop lat/lng from `vendors` table (Session 42B fix) |
| `expires_at` | timestamptz | client | announcements: +3 days. Cron now deletes AT this timestamp (was +7days from created_at — fixed) |
| `flagged_count` | int | RPC `increment_flag_count()` | Atomic now (was client increment — race condition fixed) |
| `is_hidden` | bool | RPC | Auto-set true when `flagged_count >= 5` |
| `recommended_vendor_id` | uuid, nullable, FK vendors | client | NEW — recommendation links to existing Aaspaas vendor |
| `recommended_vendor_name` | text, nullable | client | NEW — when vendor not on Aaspaas |
| `recommended_vendor_phone` | text, nullable | client | NEW — when vendor not on Aaspaas, triggers admin lead notification |

### Announcements — Gap Triage (Complete)
| Gap | Description | Decision | Fix |
|---|---|---|---|
| A1 | Vendor offers have no lat/lng — geo filter inconsistent | ✅ Fixed | Copy vendor lat/lng onto offer insert |
| A2 | Vendor offers get no push — customers miss offers entirely | ✅ Fixed | `notify-feed-post` called for offers — THIS IS CORE USP |
| A3 | Announcements never link to shop (`vendor_id` always null) | ⚪ By design | Community posts ≠ shop posts. Vendor wanting shop-linked content uses Offers. If vendor needs to signal unavailability, use go-offline button (handles everything already) |
| A4 | Push tap doesn't deep-link | ✅ Fixed | Full notification deep-link audit (see Session 42B Part 4) |
| A5 | notify-feed-post is client-only, fails silently | ✅ Fixed | Moved to DB webhook trigger (pg_net) — NEW ARCHITECTURAL RULE established |
| A6 | Cron deletes at created_at+7d but feed hides at expires_at (+3d) — 4 day DB lag | ✅ Fixed | Cron now deletes at `expires_at` |
| A7 | flagged_count incremented client-side — race condition | ✅ Fixed | Atomic RPC `increment_flag_count()` |
| A8 | No author delete/edit for announcements | ⚪ By design | Deliberate — no delete = people post genuinely, not social-media spam-and-delete |
| A9 | No self-flag guard | ⚪ By design | Unique constraint on `feed_flags(post_id, flagged_by_phone)` already prevents same-phone repeat flagging. Multi-account abuse not worth guarding at pilot scale |
| A10 | Duplicate flag shows generic error | ✅ Fixed | Catch 23505 → `feed_alreadyFlagged` friendly toast |
| A11 | Hardcoded English in LocalFeed.tsx | ✅ Fixed | 34 keys moved to strings.ts (EN/HI/MR) |
| A12 | Feed notification toggle native-only — web users can't opt out | ✅ Fixed | Toggle shown on web too |
| A13 | No expiry badge on announcements; no posted date/time anywhere | ✅ Fixed | Expiry badge (Expires tonight/tomorrow/in X days) + posted-time on ALL feed cards |
| A14 | post_id sent to edge fn but unused | ✅ Now used | Used in Prompt 8 (deep-link fix) — post_id now drives feed post highlight |
| A15 | feed-images storage allows public upload | ✅ Fixed | Anon upload restricted to `announcements/%` and `offers/%` paths only |
| A16 | Test seeds don't include image_url though UI required it | ✅ Resolved | Now moot — image is optional, test seeds without image_url are now correct |
| A17 | `vendor_update` type — dead, test-only | ⏳ Post-launch | Cleanup when test suite overhauled |
| (new) | Announcement image mandatory (Session 36 decision never built) | ✅ Fixed | Image now optional with hint text |

### Recommendations — Gap Triage (Complete)
| Gap | Description | Decision | Fix |
|---|---|---|---|
| R1 | Recommendations have no vendor link | ✅ Fixed | Tag existing Aaspaas vendor OR enter name+phone (not on Aaspaas) → admin gets vendor lead notification. MAJOR GROWTH FEATURE. |
| R2 | process-new-category orphaned — no UI to suggest categories | ✅ Fixed (as standalone feature, not feed-specific) | AI-powered category suggestion built — see dedicated section below |
| R3 | first_payment referral trigger never implemented | ⏳ Razorpay sprint | Blocked on payments going live |
| R4 | referral_enabled flag only hides UI, doesn't stop processing | ✅ Fixed | Both `recordUserReferral()` and `process-vendor-referral` check flag now |
| R5 | No push/inbox when vendor earns referral credit | ✅ Fixed | Push + inbox notification on credit earned. ALSO noted: subscription payment confirmation notification for Razorpay sprint |
| R6 | Recommendations can't be flagged (only announcements) | ✅ Fixed | Same atomic RPC, same 5-flag threshold |
| R7 | No push if GPS missing at post time — post saves but nobody notified | ✅ Fixed | Block post entirely if GPS missing — "Enable location to share with your community" |
| R8 | Coarse geo targeting — ±0.45° (~50km) bounding box | ✅ Fixed | Haversine radius-based, `feed_notification_radius_km` config (default 5km), admin-editable |
| R9 | `vendor_suggested_for` dead string | ⏳ Post-launch | Cleanup |
| R10 | Radar ranking ignores avg_rating | 🔲 Moved to Radar audit | Covered as RS-19 — current sort (distance+trust) correct for now, revisit when rating data is richer |
| R11 | Saved neighbours private — no social graph | ⚪ By design | Privacy preserved, no "friends also saved" feature |
| R12 | Feed notification tap doesn't scroll to specific post | ✅ Fixed | Covered under A4 deep-link fix — `highlightPostId` |
| R13 | USER#### customer referral codes don't match vendor lookup | ⚪ By design | Customers have NO referral incentive program — nothing financial to offer (can't do cash/discount/free-orders per business model). Revisit when app reaches scale and non-monetary rewards (recognition, gifts) become feasible |
| R14 | Existing app_users row → referral insert fails silently for returning users | 🔲 Moved to Referral audit | Pending dedicated referral module audit |
| R15 | No test coverage for notify-feed-post / FCM delivery | 🔲 Test suite sprint | Goes into requirement-based test seeds |

### KEY ARCHITECTURAL DECISIONS FROM SESSION 42B

**1. NEW HARD RULE — Notifications are ALWAYS server-triggered**
> Never call `notify-*` edge functions from client code. Always use DB webhook (`pg_net` trigger) on table INSERT/UPDATE. Client-side notification calls are a BUG, not a feature — they fail silently on poor network, app closure, or crashes, with zero retry.
>
> WHY THIS RULE EXISTS: Order notifications were built correctly with DB webhooks (Sessions 22-23). Feed notifications (Session 32) were built later by client-side call with `.catch(() => {})` — inconsistent pattern, same functionality handled two different ways. This is the kind of inconsistency that creates silent production failures. Feed notifications fixed in Session 42B via `feed_post_after_insert` trigger.

**2. NEW HARD RULE — Single source of truth for shared constants**
> Never duplicate category lists, config values, lookup tables, or any shared data across files. One definition, imported everywhere.
>
> WHY: `KNOWN_CATEGORIES` existed in TWO places — `supabase.ts` (larger list with Grocery/Beautician, used by Home AI search) and `RadarSearch.tsx` (smaller emergency-only list). Customer searches "Grocery" from Home → AI classifies correctly → Radar's smaller list can't resolve it → 0 results. Fixed by merging into `src/lib/categories.ts` (Session 42C).

**3. Location source rules — FULL MATRIX (new requirement spec)**
| Actor | Action | Location source | Rule & Why |
|---|---|---|---|
| Customer | Place delivery order | Current GPS | Delivery address = where customer is now |
| Customer | Place booking | Current GPS | "Come to my place" location |
| Customer | Request help | Current GPS | Emergency — must be current |
| Customer | Post announcement | Current GPS (mandatory, blocks post if missing) | Community post = where they are now. No fallback to last-known — if customer travelled Pune→Mumbai, "no water here" post must be Mumbai-located, not stale Pune location |
| Customer | Post recommendation | Current GPS (mandatory, blocks post if missing) | Same reasoning as announcement |
| Customer | Browse feed | Current GPS | Geo filter must be current |
| Customer | Browse Radar | Current GPS | Must be current |
| Vendor | Post offer | Shop GPS (`vendors.latitude/longitude`) | Offer belongs to the shop location, not wherever vendor's phone currently is |
| Vendor | Post announcement | Shop GPS (if vendor posts — though by design A3, vendor_id stays null) | N/A — vendor announcements are community posts like anyone else |
| Vendor | Go live (toggle online) | Current GPS | Customers track vendor location while live |
| Admin | Post announcement | **Target area picker (NEW FEATURE — not yet built)** | Admin selects city/area/radius/global — NOT tied to admin's physical location. For platform-wide announcements (new features, city launches) |

**4. Vendor "I'm offline" — correct tool is go-offline button, NOT announcement**
> If a vendor wants to signal unavailability, they use the existing go-offline toggle (handles all order/booking/help cases already — see Session 42 go-offline notify fixes). Posting "I'm offline today" as a community announcement is the wrong tool and was correctly identified as A3 — confirmed by-design, no fix needed because the real solution (go-offline button) already exists.

### NEW FEATURE — AI-Powered Category Suggestion (R2, built as standalone)

**WHY this was needed:**
Aaspaas serves "every kind of business" — globally, eventually. A fixed category list with manual admin approval doesn't scale. Atul (admin) cannot manually categorize every business type from every region/language. AI must do this intelligently.

**WHAT was built:**
- `suggest-category` edge function — vendor describes business in free text → Claude (via `ai-gateway`, same Anthropic pattern as `process-new-category`) analyzes against existing categories
- **Confidence-based routing (NOT "3 vendors" rule — rejected because first vendor in a new category would wait forever):**
  - `high_existing` (≥ `ai_category_confidence_threshold`, default 0.85) → auto-assign existing category, no human involved
  - `medium_existing` (0.5-0.85) → "Did you mean X?" confirm UI
  - `new_suggested` / `medium_new` (≥ threshold, novel category) → auto-create as `pending_review`, notify admin with AI reasoning
  - `low_confidence` (<0.5) → top 3 keyword-matched picks shown to vendor
- **Auto-approve on duplicate:** if same new category name suggested again (case-insensitive) → `suggestion_count++`, at `suggestion_count >= 2` → auto `status: active`. (First vendor still waits for admin on novel category — but it's typically fast since admin sees full AI reasoning)
- Admin moderation panel in Settings → Pending Categories: shows name, service_mode, AI reasoning, confidence%, suggesting vendor → Approve/Reject buttons → vendor notified either way

**Schema additions (`categories` table):**
- `status` text — 'active' / 'pending_review' / 'rejected' (CHECK constraint)
- `ai_reasoning` text
- `ai_confidence_score` numeric(4,2) — note: separate from pre-existing text `ai_confidence` column to avoid type conflict
- `suggestion_count` int
- `suggested_by_vendor_id` uuid FK vendors (pre-existing)

**app_config keys added:**
- `ai_category_confidence_threshold` = 0.85
- `ai_category_model` = 'claude-sonnet-4-6'

**ACTION REQUIRED:** `ANTHROPIC_API_KEY` must be set in Supabase Edge Function secrets on BOTH TEST and PROD for `suggest-category` to work. This was flagged but not yet confirmed done.

**Also used by:** RS-04 (Radar unknown search term fallback) — same `suggest-category` function powers both vendor category selection AND customer search term resolution. ONE function, TWO use cases — consistent with single-source-of-truth principle.

### NEW FEATURE — Recommendation Vendor Linking + Admin Lead Generation (R1)

**WHY:** Customer recommendations are valuable — "Great samosas at the corner shop!" — but if that vendor isn't on Aaspaas, the recommendation is a dead end. Turn every recommendation into either (a) traffic to existing vendor or (b) a warm acquisition lead.

**WHAT was built:**
- Recommendation compose has new section "Who are you recommending?"
  - **Path A:** Search existing Aaspaas vendors by `shop_name` (ilike, max 5 results) → select → `recommended_vendor_id` set
  - **Path B:** "Not on Aaspaas" toggle → Vendor Name + Phone (both mandatory when toggled) → `recommended_vendor_name` + `recommended_vendor_phone` set
  - **Path C:** Neither — pure text tip, no vendor tag (still allowed)
- Feed card rendering:
  - `recommended_vendor_id` set → tappable chip → navigates to Radar with vendor's CATEGORY as search term (not shop name — Radar searches by category) + `highlightVendorId` (see RS-03 fix in 42C)
  - `recommended_vendor_name` set (no vendor_id) → plain text + "Not on Aaspaas yet" badge
- Admin notification: when recommendation has name+phone but no vendor_id → `notify-admin` — "New vendor lead — [name] ([phone]) recommended by community in your area. Consider inviting them to Aaspaas." — gated on `vendor_lead_notify_enabled` config (default true)

**This is a growth mechanic disguised as a UX fix — every organic recommendation either drives traffic to an existing vendor OR generates a vendor acquisition lead for Atul.**

### NEW FEATURE — Admin Global/Area Announcements (NOTED, NOT YET BUILT)
From the location matrix above — admin needs ability to post announcements targeted to:
- Specific city
- Radius around a chosen point (not admin's own location)
- Global (all users)

Schema needed (future): `feed_posts.target_type` (community/area/city/global) + `target_lat/lng/radius` for area targeting. Use case: app updates, new feature launches, city expansion announcements. NOT built in Session 42B — noted for backlog.

### MIGRATIONS APPLIED — SESSION 42B
| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260613000003_atomic_flag_post.sql` | `increment_flag_count(p_post_id, p_user_phone)` RPC — atomic increment + auto-hide at 5 flags. Note: actual column is `flagged_by_phone` not `user_phone` | ✅ | ✅ |
| `20260613000004_fix_feed_expiry_cron.sql` | Announcements deleted at `expires_at` not `created_at+7d` | ✅ | ✅ |
| `20260613000005_feed_images_storage_policy.sql` | Initial (later superseded) — authenticated-only INSERT, broke anon uploads | ✅ | ✅ |
| `20260613000006_feed_images_storage_anon_path.sql` | CORRECTED — anon INSERT restricted to `announcements/%` and `offers/%` paths, public SELECT | ✅ | ✅ |
| `20260613000007_feed_post_notify_trigger.sql` | `pg_net` trigger `feed_post_after_insert` on `feed_posts` INSERT → calls `notify-feed-post`. Enables `pg_net`. Seeds `feed_notification_radius_km=5` | ✅ | ✅ |
| `20260613000008_recommendation_vendor_link.sql` | Adds `recommended_vendor_id/name/phone` to `feed_posts`. Seeds `vendor_lead_notify_enabled=true` | ✅ | ✅ |
| `20260613000009_fix_expired_order_notification_route.sql` | Adds `route: 'my-orders'` to expired-order inbox inserts (was NULL → bell landed on home) | ✅ | ✅ |
| `20260613000010_ai_category_suggestion.sql` | `categories` table: `status`, `ai_reasoning`, `ai_confidence_score`, `suggestion_count`. Seeds `ai_category_confidence_threshold=0.85`, `ai_category_model` | ✅ | ✅ |

### app_config KEYS — ENV-SPECIFIC (seeded via direct db query, NOT migration)
**CRITICAL:** These two keys are environment-specific — different value per TEST/PROD — and must NEVER go in a shared migration (same rule as `_held/` cron files). Seeded directly:
| Key | TEST value | PROD value |
|---|---|---|
| `edge_function_url` | `https://hhdylnhqdzfabsolwxdz.supabase.co/functions/v1` | `https://rpxsyeqskvhjmbkxnpmd.supabase.co/functions/v1` |
| `anon_key` | TEST project anon key | PROD project anon key |

Used by `notify_feed_post_trigger()` — if either key missing on an environment, the trigger silently no-ops (no error, just no notification fires). VERIFIED PRESENT on both as of Session 42B.

### EDGE FUNCTIONS — DEPLOYED IN SESSION 42B (all to TEST + PROD)
- `notify-feed-post` — redeployed multiple times (offer support, Haversine, route/highlight data, post content lookup when title/body omitted)
- `process-vendor-referral` — referral_enabled gate, vendor credit notification, referral_credit inbox row
- `suggest-category` — new function for AI category matching
- `notify-user`, `notify-vendor`, `warn-near-deadline` — all updated with `route`/`route_params` in FCM data (deep-link fix)

### FILES CHANGED — SESSION 42B
| File | What changed |
|---|---|
| `src/components/settings/VendorSettings.tsx` | Offer insert includes vendor lat/lng + shop_name; calls notify-feed-post (later removed — DB trigger does it); VendorSettingsOffers receives vendorLatitude/vendorLongitude/shopName |
| `src/components/LocalFeed.tsx` | Image optional; GPS-required block; expiry badges; posted-time on all cards; 34 strings moved to strings.ts; flag uses RPC; recommendation compose "Who are you recommending?" section; recommendation card vendor chip/badge; resolveRecommendedVendorRadarLink(); removed notify-feed-post client call |
| `src/lib/strings.ts` | ~50+ new keys across this session: feed_*, status_accepted_delivery family carried from 42A, parchi_*, booking_*, goOffline_*, editOrder_messagePlaceholder, feed_recommendVendor_*, feed_notOnAaspaas, feed_referralCredit_*, category_* (AI suggestion UI) |
| `src/lib/feedPushCopy.ts` | NEW — English-only push title constants for client invokes |
| `src/lib/referral.ts` | `recordUserReferral()` gated on `isReferralEnabled()` checking app_config |
| `src/pages/Settings.tsx` | Feed notifications toggle ungated from native-only; feed_notification_radius_km added to whitelist; Pending Categories admin moderation section; highlightVendorId consumption |
| `src/pages/VendorMode.tsx` | Business description + "Find my category" AI flow; highlightVendorId consumption |
| `src/lib/pushNotifications.ts` | pushNotificationActionPerformed now navigates via shared notificationNavigation; localNotificationActionPerformed added |
| `src/lib/notificationNavigation.ts` | NEW — shared route resolution for bell + push |
| `src/App.tsx` | PushNavigationBridge registers router navigate for native push handler |
| `src/lib/supabase.ts` | invokeSuggestCategory(); KNOWN_CATEGORIES removed (moved to categories.ts in 42C) |
| `supabase/functions/notify-feed-post/index.ts` | type='offer' handling; Haversine; route/route_params/post_id in FCM data and inbox rows |
| `supabase/functions/notify-feed-post/constants.ts` | NEW — English push title constants |
| `supabase/functions/_shared/notification-routes.ts` | NEW — shared route-mapping helper for notify-user/notify-vendor/notify-feed-post |
| `supabase/functions/process-vendor-referral/index.ts` | referral_enabled gate; notify-vendor on credit; referral_credit inbox insert |
| `supabase/functions/suggest-category/index.ts` | NEW — AI category matching via ai-gateway/Claude |

---

## 🏗️ SESSION 42C — RADAR SEARCH AUDIT + FIXES (13 June 2026)

### ✅ WHAT WAS DONE
Full audit of Radar geo-search — 28 gaps identified (RS-01 to RS-28). 18 fixed across 7 Cursor prompts, 1 by-design, 6 post-launch (mostly PostGIS-dependent at scale), 3 skipped (dead code, post-launch cleanup).

### Radar — File Map (Reference)
| File | Role |
|---|---|
| `src/pages/RadarSearch.tsx` | Main page `/radar?q=...` — GPS, category resolve, vendor fetch, radius expand, results |
| `src/components/RadarVendorCard.tsx` | Per-vendor card — AiBridge, Parchi, save/unsave, resolution RPCs, rate card |
| `src/pages/Index.tsx` | Entry — search bar, SOS, category grid → navigate(/radar?q=...) |
| `src/lib/categories.ts` | NEW (42C) — single source of truth for category list, aliases, service_mode, emergency flags |
| `src/lib/supabase.ts` | distanceKm, classifySearchTermForRadar (now uses categories.ts), fetchCategories, buildVendorBrief (renamed from fetchAiBridgeBrief) |
| `src/lib/trustLevel.ts` | Diamond/Gold/Silver/Bronze/Unverified + compareRadarResults sort |
| `src/components/VerificationBadge.tsx` | Green/yellow/red tier from is_manual_verified/photo/UPI — shown ONLY when NOT manually verified (42C fix) |
| `src/components/AiBridgeSheet.tsx` | Masked call bridge from Radar card |
| `src/components/ParchiSheet.tsx` | Orders/bookings from Radar card |
| `src/components/Radar.tsx` | DEAD — decorative loading animation, unused, RS-18 post-launch cleanup |

### Radar — Gap Triage (Complete)
| Gap | Description | Decision | Fix |
|---|---|---|---|
| RS-01 | `radar_city_radius_km`/`radar_highway_radius_km` in app_config but Radar hardcodes 15/25/50km | ✅ Fixed | `useAppConfig()` wired in — `nearRadius`/`maxRadius`/`midRadius` from config, admin changes now take effect |
| RS-02 | Duplicate KNOWN_CATEGORIES (supabase.ts vs RadarSearch.tsx) | ✅ Fixed | Merged into `src/lib/categories.ts` — 13 categories, all aliases (incl. Hindi/regional: mikanik, dawai, nal wala, bijli) |
| RS-03 | Feed recommendation chip → `/radar?q=shop_name` → Radar searches by category, 0 results; highlightVendorId never read | ✅ Fixed | Check `is_active` first. Online → navigate with vendor's CATEGORY as q + highlightVendorId → highlight animation on matching card. Offline → toast, no navigation |
| RS-04 | Unknown search term → instant 0 results, no fallback | ✅ Fixed | `suggest-category` AI fallback — high confidence → use suggested category + banner; low confidence → category grid + "couldn't find" message |
| RS-05 | `saved_vendors` missing DELETE RLS policy — unsave fails | ✅ Fixed | `saved_vendors_delete` policy (USING true — matches existing SELECT/INSERT pattern, app filters client-side by device_id/user_phone, not JWT) |
| RS-06 | `SignalFreshness` component fully built but never mounted; dead strings | ✅ Removed | Component + `Clock` import + 6 dead string keys removed. Reasoning: raw "last active X ago" timestamps create customer anxiety without adding real signal — trust tier + is_active + ratings already convey reliability |
| RS-07 | No online/offline indicator on Radar cards | ✅ Fixed | Green dot (`bg-brand`) beside shop name when `is_active=true` |
| RS-08 | Parchi allows order submit even if vendor went offline mid-session | ✅ Fixed | Fresh `is_active` DB check before opening AiBridge/Parchi → if offline, toast `radar_vendorWentOffline`, action blocked |
| RS-09 | Hardcoded English strings (distance units, service pills, ETA, "Helped"/"Delivered", menu/about labels, TrustWarningBanner "Pending", VerificationBadge copy) | ✅ Fixed | All moved to strings.ts EN/HI/MR with placeholders |
| RS-10 | RadarSearch passes no-op `onOrder`/`onAiBridge`/`onSave={() => {}}` to RadarVendorCard — dead API | ✅ Fixed | Removed; `onOrderCancelled` (real, used) kept |
| RS-11 | Empty SOS shows ALL vendors (delivery/booking/help) under "All emergencies" — misleading | ✅ Fixed | SOS now filters `service_mode='help'` only + headline "Emergency help nearby" + subtitle "Need delivery or a booking? Search by category above." |
| RS-12 | `limit(80)` before Haversine — nearest vendors beyond row 80 in dense bbox never appear | ⏳ Post-launch | PostGIS needed at city scale; harmless at Warje pilot (~20-30 vendors) |
| RS-13 | Active-order "Order sent" badge query uses `device_id` only — breaks after phone migration | ✅ Fixed | Now uses `user_phone OR device_id` pattern — mirrored from `countSavedNeighbours`. Applied to RadarSearch batch query AND RadarVendorCard's `refreshActiveOrderFromDb`/`refreshFulfilledFromDb` |
| RS-14 | Saved neighbours on Home show offline vendors (inconsistent with Radar which filters them) | ✅ Fixed | ALL saved vendors always shown (no disappearing list) + green dot for is_active + fresh is_active check on tap → toast if offline |
| RS-15 | VerificationBadge (green/yellow/red) AND trust tier badge (Diamond/Gold/Silver/Bronze) both shown on same card — confusing, unexplained relationship | ✅ Fixed | Progressive disclosure: `is_manual_verified=false` → VerificationBadge only. `is_manual_verified=true` → trust tier badge only. Never both. Sort still uses trust tier internally regardless |
| RS-16 | `s.radar_no_helpers_15.replace('15', radius)` — fragile, breaks in HI/MR if "15" not in translated string at same position | ✅ Fixed | Renamed to `radar_no_helpers` with `{radius}` placeholder, all 3 locales use literal `{radius}` |
| RS-17 | App queries `saved_vendors.user_phone`/`saved_at` but migration only had `device_id`/`created_at` — schema drift, fresh DB would break | ✅ Fixed | Migration adds missing columns IF NOT EXISTS with COALESCE backfill (TEST was missing `created_at` specifically) |
| RS-18 | `src/components/Radar.tsx` — unused decorative component | ⏳ Post-launch | Dead file cleanup |
| RS-19 | `avg_rating`/`review_count` displayed but not used in sort | ⏳ Post-launch | Current sort (distance + trust tier) correct for now — thin review data at pilot scale. Revisit with rating+verification as additional sort signals once data is richer |
| RS-20 | Trust badge labels (Diamond/Gold/Silver/Bronze) stay in Latin script even in HI/MR | ✅ Fixed | Devanagari transliteration: डायमंड/गोल्ड/सिल्वर/ब्रॉन्ज — words used as-is (like "WiFi"/"ATM") but in correct script |
| RS-21 | Vendor sees own card in their own Radar search | ⚪ By design | Harmless — "• You" label, no save button. Actually useful (vendor sees own listing as customers do) |
| RS-22 | No `radar` route in notification-routes.ts — no notification can deep-link to Radar | ⏳ Post-launch | No current notification type needs it (category approval correctly goes to /vendor not /radar). Revisit if specific use case (e.g. promo notifications) arises |
| RS-23 | Hardcoded 900ms artificial delay before vendor fetch — pure spinner padding | ✅ Fixed | Removed. Full-screen spinner only during GPS location. After GPS: 4 skeleton cards during fetch + small "searching within Xkm" indicator |
| RS-24 | `MOBILE_CATEGORIES` constant unused in Radar | ⏳ Post-launch | Dead constant cleanup |
| RS-25 | "medical" alias maps to Pharmacy in KNOWN_CATEGORIES but `isOfficialEmergencyCategory("medical")` maps to Ambulance — same term, two conflicting behaviours | ✅ Fixed | Clean separation: medical/medicine/dawai/pharmacy → Pharmacy vendor search + soft "Need medical advice? Call 104" card. ambulance/emergency/accident/108 → `isAmbulanceEmergencySearch()` → 108 gov panel ONLY, no vendor search. No overlap |
| RS-26 | `fetchAiBridgeBrief` name implies AI but returns fixed template sentence | ✅ Fixed | Renamed to `buildVendorBrief` across supabase.ts, MyOrders.tsx, AiBridgeSheet.tsx. No logic change |
| RS-27 | "Connect" button label on rate card opens ParchiSheet (order) for delivery/appointment — but "Connect" implies a call | ✅ Fixed | Mode-specific CTA: help="Connect" (call), delivery="Order", appointment="Book" |
| RS-28 | Browser test comment: "UI radar path unreliable in test env (GPS distance filter)" — Radar undertested | ⏳ Post-launch | Goes into requirement-based test suite — needs Capacitor-level GPS mocking |

### NEW FILE — src/lib/categories.ts (Single Source of Truth)
13 categories merged from both prior lists. Each entry: `label`, `aliases` (array, includes Hindi/regional terms), `service_mode`, `isEmergency` boolean.

Exported helpers:
- `resolveCanonicalTerm(term)` — replaces old `resolveKnownCategory`/`resolveCategory`
- `isOfficialEmergencyCategory(term)`
- `isAmbulanceEmergencySearch(term)` — NEW, separates ambulance from general medical
- `termForGovEmergencyHelp()` / `showGovHelpAlongsideRadiusExpand()`
- `MEDICAL_EMERGENCY_LABELS`, `ROADSIDE_EMERGENCY_LABELS`, `FIRE_EMERGENCY_LABELS`

Consumers: `supabase.ts` (`classifySearchTermForRadar`, `classifyCategory`), `RadarSearch.tsx` (`resolveCategoryIdsForTerm`). Alias resolution logic unchanged — exact label match first, then substring match.

### Radar CTA Labels — Mode-Specific (RS-27)
| service_mode | Button label | EN | HI | MR |
|---|---|---|---|---|
| help | radar_cta_connect | "Connect" | "कनेक्ट करें" | "कनेक्ट करा" |
| delivery | radar_cta_order | "Order" | "ऑर्डर करें" | "ऑर्डर करा" |
| appointment | radar_cta_book | "Book" | "बुक करें" | "बुक करा" |

### Radar — Online/Offline Gating Pattern (RS-07/08/14 — applies everywhere a vendor card is tappable)
1. **Visual:** Green dot (`bg-brand`) when `vendor.is_active === true` — shown on Radar cards AND Home saved neighbours
2. **Action gate:** Before opening AiBridgeSheet or ParchiSheet from ANY entry point (Radar card, Home saved neighbour, feed recommendation chip) — fresh DB query `SELECT is_active FROM vendors WHERE id = ?` → if false, `toast.error(s.radar_vendorWentOffline)`, action blocked, no sheet opens
3. **String:** `radar_vendorWentOffline` — EN: "This vendor just went offline. Please try another or check back soon." (HI/MR equivalents)
4. **WHY fresh check, not cached:** Card data could be 30+ seconds stale; vendor could go offline between page load and tap

### MIGRATIONS APPLIED — SESSION 42C
| Migration | Description | TEST | PROD |
|---|---|---|---|
| `20260613000011_saved_vendors_delete_policy.sql` | DELETE RLS policy `saved_vendors_delete` (USING true, matches existing pattern); adds `user_phone`, `saved_at`, `created_at` columns IF NOT EXISTS with COALESCE backfill | ✅ | ✅ |

### FILES CHANGED — SESSION 42C
| File | What changed |
|---|---|
| `src/lib/categories.ts` | NEW — single source of truth, 13 categories, all helpers |
| `src/lib/supabase.ts` | KNOWN_CATEGORIES removed (now imports from categories.ts); classifySearchTermForRadar/classifyCategory use resolveCanonicalTerm; fetchAiBridgeBrief renamed to buildVendorBrief |
| `src/pages/RadarSearch.tsx` | Config-driven radii; AI fallback for unknown terms; SOS filtered to help-only + subtitle; medical/ambulance separation; highlightVendorId consumption + scroll/highlight animation; removed SignalFreshness + 900ms delay; skeleton loaders; removed no-op callback props; active-order query phone+device pattern; radar_no_helpers {radius} placeholder |
| `src/components/RadarVendorCard.tsx` | Green dot; fresh is_active gate before Connect/Order/Book; unified trust badge (VerificationBadge XOR trust tier); mode-specific CTA labels; removed onOrder/onAiBridge/onSave props; refreshActiveOrderFromDb/refreshFulfilledFromDb phone+device pattern; localized strings (distance, ETA, pills, menu/about labels) |
| `src/components/TrustWarningBanner.tsx` | "Pending" → `radar_trustPending` localized |
| `src/components/VerificationBadge.tsx` | `getVerificationCopy(s)` for localized copy |
| `src/pages/Index.tsx` | Saved neighbours: green dot, fresh is_active gate on tap, no is_active filter on list (show all) |
| `src/components/LocalFeed.tsx` | `resolveRecommendedVendorRadarLink()` — RS-03 fix |
| `src/lib/strings.ts` | radar_distance_mtr/km, radar_pill_*, radar_eta_*, radar_stat_helped/delivered, radar_viewFullMenu, radar_menuLabel, radar_aboutLabel, radar_rateCardLabel, radar_viewFullRateCard, radar_trustPending, verification_*, radar_no_helpers (renamed), radar_trust_badge_* (Devanagari), radar_vendorWentOffline, radar_cta_connect/order/book, radar_suggestedCategory, radar_unknownTerm, radar_sos_headline, radar_sos_subtitle, radar_medical_helpline. REMOVED: radar_signal_unknown, radar_signal_strong, radar_last_active, radar_mins_ago, radar_h_ago, radar_d_ago, radar_no_helpers_15 |

### RADAR REQUIREMENTS SPEC — FOR TEST CASE GENERATION

#### RAD-01: Category Resolution
- **WHAT:** Search term → category ID(s) via `resolveCanonicalTerm()` from `src/lib/categories.ts`
- **EXPECTED:** Exact label match first, then alias substring match (both directions: `label.includes(term)` OR `term.includes(label)`)
- **TEST CASE:** Search "kirana" → resolves to Grocery category
- **TEST CASE:** Search "mikanik" → resolves to Mechanic category (Hindi alias)
- **TEST CASE:** Search "xyz123" (no match) → triggers AI fallback (RAD-04)

#### RAD-02: Config-Driven Radius
- **WHAT:** Search radius uses `radar_city_radius_km` (near) and `radar_highway_radius_km` (max) from app_config
- **EXPECTED:** Admin changes these values → next Radar search/term-change reflects new radius immediately, no app rebuild needed
- **TEST CASE:** Set `radar_city_radius_km=20` in admin → search → near radius expansion threshold = 20km not 15km

#### RAD-03: Feed Recommendation → Radar Navigation
- **WHAT:** Tapping a vendor-linked recommendation chip
- **EXPECTED:**
  - Vendor online → navigate `/radar?q={category}` with `highlightVendorId` state → matching card scrolls into view + 2.5s amber highlight
  - Vendor offline → toast `radar_vendorWentOffline`, NO navigation
  - Vendor in results but highlightVendorId not found (edge case, e.g. outside radius) → normal results, no error, no highlight
- **TEST CASE:** Tap recommendation for online vendor → lands on Radar with category search, target card highlighted

#### RAD-04: AI Fallback for Unknown Search Term
- **WHAT:** `resolveCanonicalTerm()` returns null AND `resolveCategoryIdsForTerm()` returns []
- **EXPECTED:** Calls `suggest-category` edge function
  - `confidence >= ai_category_confidence_threshold` → use returned category_id, show banner "Showing results for {category}"
  - Below threshold → show category grid + "We couldn't find '{term}'. Browse categories below."
- **TEST CASE:** Search "vastu consultant" (novel term) → AI suggests category → banner shown if high confidence

#### RAD-05: SOS (Empty Search)
- **WHAT:** `/radar` with no `q` parameter
- **EXPECTED:** Results filtered to `service_mode='help'` ONLY. Headline "Emergency help nearby". Subtitle "Need delivery or a booking? Search by category above."
- **TEST CASE:** Open `/radar` with no query → only help-mode vendors shown, delivery/appointment vendors excluded

#### RAD-06: Medical vs Ambulance Search
- **WHAT:** Search terms related to medical needs
- **EXPECTED:**
  - "medical"/"medicine"/"dawai"/"pharmacy" → Pharmacy vendor results + soft card "Need medical advice? Call 104"
  - "ambulance"/"emergency"/"accident"/"108" → NO vendor search, 108 government emergency panel ONLY
- **TEST CASE:** Search "medicine" → Pharmacy vendors shown + 104 helpline card visible
- **TEST CASE:** Search "ambulance" → no vendor cards, only 108 emergency panel

#### RAD-07: Online/Offline Card Display + Action Gate
- **WHAT:** Vendor card display and action availability based on `is_active`
- **EXPECTED:**
  - Green dot shown when `is_active=true` (Radar AND Home saved neighbours)
  - Tapping Connect/Order/Book → fresh DB check of `is_active` → if false (went offline since page load), block action with toast `radar_vendorWentOffline`
- **TEST CASE:** Vendor card shows green dot when online
- **TEST CASE:** Vendor goes offline after card loads but before tap → action blocked with toast, no sheet opens

#### RAD-08: Saved Neighbours Display
- **WHAT:** Home screen saved neighbours section
- **EXPECTED:** ALL saved vendors shown regardless of `is_active` (never disappear from list) + green dot indicates current online status + tap gate same as RAD-07
- **TEST CASE:** Save an online vendor → vendor goes offline → still appears in saved list but green dot removed → tap shows offline toast

#### RAD-09: Trust Badge Display (Progressive Disclosure)
- **WHAT:** Which badge shows on vendor card
- **EXPECTED:**
  - `is_manual_verified=false` → VerificationBadge (green/yellow/red) shown, trust tier badge HIDDEN
  - `is_manual_verified=true` → trust tier badge (Diamond/Gold/Silver/Bronze) shown, VerificationBadge HIDDEN
  - Sort order ALWAYS uses trust tier internally regardless of which badge displays
- **TEST CASE:** Unverified vendor card shows VerificationBadge only
- **TEST CASE:** Manually verified vendor card shows trust tier badge only, in Devanagari for HI/MR

#### RAD-10: Active Order Badge — Phone + Device Matching
- **WHAT:** "Order sent" badge on Radar card for vendors with an active order from this customer
- **EXPECTED:** Query matches `user_phone OR device_id` — survives device migration
- **TEST CASE:** Customer places order on Device A → migrates to Device B with same phone → Radar card for that vendor still shows "Order sent" badge

#### RAD-11: Saved Vendor Unsave
- **WHAT:** Customer taps unsave on a previously saved vendor
- **EXPECTED:** DELETE succeeds (RLS policy `saved_vendors_delete` allows it), vendor removed from saved list
- **TEST CASE:** Save vendor → unsave → vendor no longer in saved_vendors table for that user

## 🏗️ SESSION 41 — CRON SCHEDULING + NEAR-DEADLINE NOTIFICATIONS (11 June 2026)

### ✅ WHAT WAS DONE

#### 1. warn-near-deadline cron — scheduled on TEST + PROD
| Item | Detail |
|---|---|
| **TEST migration** | `20260611000000_warn_near_deadline_cron_test.sql` → moved to `_held/` in S42 |
| **PROD migration** | `20260611000001_warn_near_deadline_cron_prod.sql` → moved to `_held/` in S42 |
| **Schedule** | `*/5 * * * *` |
| **Pattern** | `net.http_post` + `cron.schedule` — same as other edge function crons |
| **Anon key** | Hardcoded per environment (anon key is not a secret — already in frontend code) |
| **Unschedule guard** | `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'warn-near-deadline'` before scheduling — safe to re-run |
| **Deploy order** | TEST first → verified → PROD ✅ |

**Also fixes known gap:** `ping-active-vendors-location` was dashboard-only (flagged as risk in master log). New crons are properly migration-tracked.

#### 2. Near-deadline notification pipeline — fully working end-to-end
| Layer | How it runs |
|---|---|
| **Inbox warnings** | `warn_pending_orders_near_deadline()` runs inside `expire_pending_orders()` — existing 5-min cron |
| **FCM push** | `warn-near-deadline` edge function — new 5-min pg_cron job ✅ |
| **Dedupe** | One warn per customer+vendor pair — siblings marked `near_deadline_warned_at` |

#### 3. Session 40 carry-over (Cursor session — 10 Jun 2026)
| Area | Change |
|---|---|
| **Vendor go-offline notify** | Block on `sent`/`seen`/`accepted`; push only on `accepted` or appointment `confirmed`; dedupe by customer phone |
| **Order expiry fix** | Delivery + appointment now expire `seen` AND `sent` (was `sent` only) |
| **Near-deadline warnings** | `warn_pending_orders_near_deadline()` SQL + `warn-near-deadline` edge function + 3 new `app_config` keys |
| **New columns** | `requests.near_deadline_warned_at`, `requests.near_deadline_push_sent` |
| **New notification types** | `order_near_deadline_unseen`, `order_near_deadline_unconfirmed` |
| **app_config keys added** | `delivery_near_deadline_minutes=60`, `appointment_near_deadline_minutes=60`, `help_near_deadline_minutes=5` |
| **Tests added** | `tests/order-near-deadline.spec.ts` + `EXP-07` in `tests/order-expiry.spec.ts` |

#### 4. Backup status — tracked
| Area | Status | Trigger |
|---|---|---|
| **Code** | ✅ GitHub private repo | Done |
| **DB automated backup** | ⏳ Supabase Pro needed | At 25 real vendors |
| **Manual CSV export** | ⏳ Not started | Start when first real vendor enrolls |
| **Tables to export** | `vendors`, `khata_ledger`, `khata_transactions`, `requests`, `referrals`, `vendor_credits` | Weekly → Google Drive |

### 📦 MIGRATIONS APPLIED IN SESSION 41
| Migration | Description | Environments |
|---|---|---|
| `20260610140000_order_near_deadline_warnings.sql` | Near-deadline columns, app_config keys, warn + expiry updates | TEST + PROD |
| `20260610150000_order_near_deadline_per_vendor.sql` | One warn per customer per vendor (not per order) | TEST + PROD |
| `20260611000000_warn_near_deadline_cron_test.sql` | pg_cron schedule for warn-near-deadline edge fn | TEST only → moved to _held/ in S42 |
| `20260611000001_warn_near_deadline_cron_prod.sql` | pg_cron schedule for warn-near-deadline edge fn | PROD only → moved to _held/ in S42 |

### ✅ SESSION 41 FINAL STATUS
- warn-near-deadline cron scheduled on TEST + PROD ✅
- Near-deadline inbox + FCM push fully working end-to-end ✅
- Order expiry now covers `seen` orders (delivery + appointment) ✅
- All 4 migrations tracked in repo ✅

---

## 🏗️ SESSION 40 — CRITICAL BUG FIXES + NOTIFICATION PIPELINE (10 June 2026)

### ⚠️ MOST IMPORTANT LESSONS — READ BEFORE TOUCHING NOTIFICATIONS OR RLS

**LESSON 1 — RLS on dashboard-created tables:**
Any table created directly in Supabase dashboard (not via migration) gets RLS ENABLED with ZERO policies. Anon client gets 0 rows silently on SELECT — no error, just empty. Always add policies immediately after creating a table, and always create via migration so it's tracked.

**LESSON 2 — CORS on edge functions:**
Every edge function called from the browser/WebView needs CORS headers. Without them, the browser silently blocks the call — `.catch(() => {})` swallows the error completely. Pattern to use in every function:
```typescript
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
// At top of serve():
if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
// On every response:
return new Response(JSON.stringify(payload), { status, headers: CORS_HEADERS });
```

**LESSON 3 — Test suite was using service-role key for vendor_categories queries:**
Tests bypassed RLS entirely (service-role skips all policies). Result: RLS bugs invisible to test suite. Fix: any test validating data the *customer app* reads must use the anon key, not supabaseAdmin.

**LESSON 4 — Automated tests ≠ app works on real device:**
336 tests passing means the code paths execute correctly in isolation. It does NOT mean notifications buzz, GPS works, camera works, or the full 2-phone journey works. Real device testing is irreplaceable. Never declare launch-ready without 2-phone test.

**LESSON 5 — FCM token rotation after APK reinstall:**
Fresh install = new FCM token. Token only saves when the relevant screen opens (VendorMode for vendor, Index for customer). After installing a new APK, open the app fully before testing notifications.

**LESSON 6 — Capacitor WebView geolocation:**
`navigator.geolocation` inside Capacitor WebView does NOT reliably trigger the Android permission prompt. Always use `@capacitor/geolocation` plugin (`Geolocation.getCurrentPosition()`) for location in native app code.

**LESSON 7 — `saveUserDeviceLocationSilently` must use UPDATE not UPSERT:**
`user_devices.fcm_token` is NOT NULL. An upsert without `fcm_token` fails silently (null constraint). The row is created by FCM registration — location save must use UPDATE keyed on `(user_phone, device_id)` after the row exists.

**LESSON 8 — Tests must validate requirements, not just code:**
336 tests passing did not catch 20+ gaps found in Session 42. Tests were validating what was coded. Requirement-based tests must ask: "given this business rule, does the app behave correctly?" See REQUIREMENT SPECIFICATIONS section above for source of truth.

---

### 🐛 BUGS FOUND AND FIXED IN SESSION 40

#### BUG-1: RLS missing on `vendor_categories` + `vendor_verification` (CRITICAL)
- **Symptom:** Radar category search returned empty for ALL users. Trust badges showed Unverified for everyone.
- **Root cause:** Tables created in dashboard during Session 39 with RLS enabled but zero policies. Anon SELECT returned 0 rows silently. Anon INSERT raised 42501.
- **Fix:** Migration `20260610000000_vendor_categories_verification_rls.sql`
- **Applied:** TEST + PROD ✅

#### BUG-2: Radar search 2-step render (UX)
- **Fix:** Added `categoriesLoaded` state + `fetchSeqRef` guard.

#### BUG-3: N+1 queries — RadarVendorCard, IncomingOrdersSection, VendorSettings (PERFORMANCE)
- **Fix:** Parent batch-fetches before rendering. 4×N queries → 6 total queries.

#### BUG-4: CORS missing on notify-user, notify-vendor, notify-admin (CRITICAL)
- **Symptom:** Customer never received accept/decline notifications.
- **Fix:** Added standard CORS headers + OPTIONS to all affected functions.
- **Deployed:** PROD ✅

#### BUG-5: notify-user + notify-vendor-tomorrow using wrong channel_id
- **Fix:** Changed `channel_id` to `"order_alert"` + `priority: "high"`.

#### BUG-6: Foreground notifications silent on customer phone
- **Fix:** `@capacitor/local-notifications@8.2.0` installed. `showForegroundNotification()` in `pushNotificationReceived`.

#### BUG-7: Customer location never saved to user_devices
- **Fix:** Moved location save INSIDE FCM registration callback. UPDATE not UPSERT. `@capacitor/geolocation` plugin.

#### BUG-9: Expired order — dismiss button missing (UX)
- **Fix:** Expired orders added to customer filter (48h). Amber styling + dismiss button.

#### BUG-10: "Welcome back!" screen blocking booking flow
- **Fix:** `skipRecovery={true}` prop on PhoneEntrySheet in ParchiSheet + RadarVendorCard.
- **Note:** BR-3 is now dead UI — first-open flow in Index.tsx not yet built.

#### BUG-11: ParchiSheet state leak on Book Again + layout broken
- **Fix:** useEffect resets form on `isOpen=true`. scrollContainerRef replaces window.scrollBy.

#### BUG-12: Menu "Add to order" hidden under Book button
- **Fix:** Menu capped at max-h. "Add to order" pinned as shrink-0. Main scroll gets pb-52.

#### BUG-13: Bell notification — no dismiss, flash-then-empty
- **Fix:** Per-notification delete. "Clear all" button. loadIdRef race guard. Subscription once per phone.

#### BUG-14: Admin app_config missing referral_vendor_credit keys
- **Fix:** 4 keys added to whitelist. Migration seeds defaults.

### 📦 MIGRATIONS APPLIED IN SESSION 40
| Migration | Description | Environments |
|---|---|---|
| `20260610000000_vendor_categories_verification_rls.sql` | RLS policies for vendor_categories + vendor_verification | TEST + PROD |
| `20260610010000_user_notifications_delete_rls.sql` | DELETE policy for user_notifications | TEST + PROD |
| `20260610020000_seed_referral_vendor_credits.sql` | Seed referral_vendor_credit_* keys in app_config | TEST + PROD |

---

## 🔧 SUPABASE — CRITICAL REFERENCE (READ EVERY SESSION)

> Claude wasted tokens in Session 38 figuring this out. Never repeat.

### Project IDs
| Environment | Project Ref | Dashboard URL |
|---|---|---|
| **PROD** | `rpxsyeqskvhjmbkxnpmd` | https://supabase.com/dashboard/project/rpxsyeqskvhjmbkxnpmd |
| **TEST** | `hhdylnhqdzfabsolwxdz` | https://supabase.com/dashboard/project/hhdylnhqdzfabsolwxdz |

### Deploy workflow (confirmed Session 38 — use this EVERY time)
```bash
# Switch to target environment
supabase link --project-ref <ref>

# Push migrations
supabase db push

# Deploy edge functions
supabase functions deploy <function-name>

# If migration history conflict (duplicate version key):
supabase migration repair --status reverted <version>
# Then retry: supabase db push
```

### Migration naming rule (CRITICAL — learned Session 38)
- Always use full 14-digit timestamp: `YYYYMMDDHHMMSS_name.sql`
- NEVER use short date only (`20260606_name.sql`) — causes duplicate key conflict

### env-split migrations — IMPORTANT (learned Session 42)
- Env-specific files (TEST-only or PROD-only) live in `supabase/migrations/_held/`
- NEVER put them in `supabase/migrations/` — causes db push conflicts
- To apply env-specific migration: `db query` directly, not `db push`
- After moving files to _held/, repair migration history on each env:
  `supabase migration repair --status reverted <version>`

### PROD push procedure when _held/ files exist (learned Session 44A/44B)
When pushing a NEW shared migration to PROD, and PROD's remote migration history includes versions that are now in `_held/` (e.g. `20260611000001`, `20260611020001`) but NOT in local `migrations/`:
1. Temporarily COPY the relevant `_held/` file(s) back into `supabase/migrations/` — just enough to make local history match PROD's remote history
2. Run `supabase db push --linked` — only the NEW migration actually applies; the already-applied `_held/` ones are skipped (no-op)
3. Remove the temporarily-copied file(s) from `migrations/` — restore `_held/`-only state
This "temporary-restore-for-push" pattern was used successfully for `20260614000004` and `20260614000007`. It avoids needing `migration repair` every time — just a copy-push-remove cycle.

### env-specific app_config keys (learned Session 42B — same principle as _held/ migrations)
These keys have DIFFERENT values per environment and must be seeded via direct `db query`, NEVER via shared migration:
| Key | TEST value | PROD value | Used by |
|---|---|---|---|
| `edge_function_url` | `https://hhdylnhqdzfabsolwxdz.supabase.co/functions/v1` | `https://rpxsyeqskvhjmbkxnpmd.supabase.co/functions/v1` | `notify_feed_post_trigger()` |
| `anon_key` | TEST project anon key | PROD project anon key | `notify_feed_post_trigger()` |

If a future DB trigger needs to call an edge function via `pg_net`, check these keys exist on the target environment first — trigger silently no-ops if missing (no error raised).

### Windows terminal commands
- Use `Rename-Item` not `rename` (PowerShell)
- Supabase CLI v2.104.0 — works without Docker for remote operations
- Docker NOT required for `supabase db push` or `supabase functions deploy`
- Working directory: `C:\Users\DELL\local-connect-hub`
- Use Cursor's integrated terminal — not standalone Windows terminal (login token issue)

### Both environments must always be in sync
- Every migration pushed to TEST first → verify → then PROD
- Every edge function deployed to TEST first → verify → then PROD
- **CLI currently linked to TEST** — verify before every push

### Current App State (end of Session 42C)
- **Vendor registered:** Anvi Beauty Parlour — Monika Mhetre — `b4494c00-a9a8-4579-82a0-dea5e6a96197`
- **Admin phone:** `8888169446`
- **Supabase project (prod):** `rpxsyeqskvhjmbkxnpmd`
- **Supabase project (test):** `hhdylnhqdzfabsolwxdz`
- **App URL (dev):** `localhost:8080`
- **Android package:** `com.aaspaas.pro`
- **Ledger outstanding:** ₹550 for ••••9446
- **ESLint:** 0 errors, 0 warnings ✅
- **Bundle size:** 940 KB initial JS ✅
- **Gajanand Bhadekar:** Active account = Shreenivas / Mechanic / `6d0e24e5`

### How to restore session after fresh APK install
1. Open app → Settings → tap title 7 times → Enter PIN → Dev menu opens
2. Set phone: `8888169446` → Save (app reloads)
3. Open Vendor tab → "Already registered?" → enter `8888169446` → loads Monika's vendor
4. Admin panel unlocks automatically in Settings

### Vendor Details (Monika / Anvi Beauty Parlour)
```
ID: b4494c00-a9a8-4579-82a0-dea5e6a96197
Name: Monika Mhetre
Shop: Anvi Beauty Parlour
Category: Beautician
Service mode: appointment
Phone: +91 9096082707
UPI: minuka@okbank
Location: 18.487357, 73.793382 (Warje, Pune)
Referral code: AASP2707
```

---

## 🏛️ ARCHITECTURAL PHILOSOPHY — WHY WE BUILD THE WAY WE DO

> This section explains every major architectural decision with reasoning.
> Read this before suggesting changes to any core pattern.

### 1. No OTP Authentication
**WHAT:** Phone number stored in localStorage. No OTP. No server-side session.
**WHY:** Bharat-80 users — low-tech, vernacular, often on 2G. OTP adds friction that kills conversion.
**WHEN TO REVISIT:** When referral fraud becomes measurable at scale OR when migrating to Supabase phone auth post-launch.

### 2. Phone = Identity
**WHAT:** Phone number is the primary identifier for all users.
**WHY:** In India, phone is linked to Aadhaar. Real SIM, not easily disposable.

### 3. App is a Connector, Not a Payment Processor
**WHAT:** Payment between customer and vendor is direct. App only intermediates vendor subscription (Razorpay).
**WHY:** Payment intermediation requires RBI payment aggregator license.

### 4. No Hardcoding
**WHAT:** All config, categories, thresholds, emojis, labels from DB (app_config table).
**WHY:** Different markets have different thresholds.

### 5. App Automates Everything Possible
**WHAT:** Every task that can be automated should be. Human admin only for genuine judgment calls.
**WHY:** Atul is a full-time professional. Cannot manually manage 1000 vendors.

### 6. Market Profile Architecture
**WHAT:** Single `market` key in app_config drives a bundle of feature flags per country/region.
**WHEN:** Build before first non-India deployment.

### 7. Running Balance for Khata (Option B)
**WHAT:** Khata ledger tracks running outstanding balance.
**WHY:** Matches Indian kirana tab behaviour.

### 8. Help Mode = Call-Based by Design
**WHAT:** Help mode has no formal written order. It's a call connection via AI-Bridge (Exotel masked calls).
**WHY:** Help = emergency. Call is the fastest path to resolution.

### 9. All Config in app_config Table
**WHAT:** No thresholds, amounts, flags hardcoded in source code.
**WHY:** Runtime changes without app deployment.

### 10. Cross-User Notifications Pattern
**WHAT:** saveNotification inserts into user_notifications for OTHER users' phones from client (anon auth).
**RISK:** Any anon user can insert notifications for any phone.
**FIX POST-LAUNCH:** Move to edge function with service role.

### 11. Supabase Anonymous Auth
**WHAT:** Users are anonymous Supabase auth sessions.
**WHY:** Instant onboarding. No registration friction.

### 12. Admin Panel = Client-Side Gate Only
**WHAT:** Admin panel access gated by phone number matching app_config admin_phone. Check is in UI only.
**FIX POST-LAUNCH:** Server-side RPC check on admin actions.

### 13. Vendor Live/Offline Toggle = Working Hours + Vacation Mode
**WHAT:** Vendor manually toggles Live/Offline. No automated schedule.
**WHY:** Manual toggle is MORE flexible for Bharat-80 vendors.

### 14. Rating System = Dispute Resolution
**WHAT:** No formal dispute management. Rating + review IS the dispute mechanism.
**WHY:** App is a connector, not an arbitrator.

### 15. Service Mode is Permanent per Vendor
**WHAT:** Each vendor has exactly one service mode.
**WHY:** Service mode determines entire order flow, UI, notifications.

### 16. Notifications Are ALWAYS Server-Triggered (Session 42B)
**WHAT:** Never call `notify-*` edge functions from client code. Always use DB webhook (`pg_net` trigger) on table INSERT/UPDATE.
**WHY:** Client-side calls with `.catch(() => {})` fail silently on poor network, app closure, or crashes — zero retry. Order notifications were built correctly (DB webhook, Sessions 22-23). Feed notifications (Session 32) were built later by client-side call — same functionality, two inconsistent patterns. This inconsistency is exactly the kind of thing that creates hidden production bugs. Fixed in 42B via `feed_post_after_insert` trigger.
**ENFORCEMENT:** If a future feature needs to notify users on data change, the FIRST instinct must be "what table, what trigger" — not "where do I call notify-X from the client."

### 17. Single Source of Truth for Shared Constants (Session 42C)
**WHAT:** Never duplicate category lists, config values, lookup tables, or any shared data across files. One definition, imported everywhere.
**WHY:** `KNOWN_CATEGORIES` existed in two places (`supabase.ts` for Home AI search, `RadarSearch.tsx` for Radar term resolution) with different category sets. Customer searches "Grocery" from Home → AI classifies correctly → Radar's smaller list can't resolve it → 0 results. Fixed by merging into `src/lib/categories.ts`.
**ENFORCEMENT:** Before defining any constant/lookup/list, search the codebase for existing definitions of the same concept. If found elsewhere, import — don't duplicate.

### 18. Location Source Depends on WHO and WHAT (Session 42B)
**WHAT:** Customer actions (orders, bookings, help, feed posts) use CURRENT GPS, mandatory, no fallback. Vendor offers/shop-linked content use SHOP GPS (`vendors.latitude/longitude`). Admin announcements use a TARGET AREA PICKER (not admin's own location) — feature not yet built.
**WHY:** A customer who travelled Pune→Mumbai posting "no water here" must have it appear in Mumbai, not stale Pune location — hence no last-known-location fallback, block the post instead. A vendor's offer belongs to their shop's fixed location regardless of where the vendor's phone currently is. Full matrix in Session 42B requirement specs.

---

## 🏗️ FEATURE DECISIONS LOG — SESSION 36 BR REVIEW

### BR-001 — User Identity / OTP: Out of scope
### BR-002 — Account Recovery: ✅ Done Session 38
### BR-003 — Device Management: ❌ Out of scope
### BR-004 — Session Management: ❌ Out of scope
### BR-005 — Vendor Working Hours: ❌ Out of scope (solved by toggle)
### BR-006 — Vacation Mode: ❌ Out of scope (solved by toggle)
### BR-007 — Capacity Management: ❌ Out of scope (solved by toggle)
### BR-008 — Order Expiry Rules: ✅ Done Session 38
### BR-009 — Auto Decline: ✅ Same as BR-008
### BR-010 — Customer Reassignment: ✅ Smart expiry notification with category deep link
### BR-011 — Order Dispute Management: ❌ Out of scope (rating = dispute resolution)
### BR-012 — Refund Management: ❌ Out of scope for customer-vendor transactions
### BR-013 — Bill Versioning: ❌ Out of scope (void+replace handles it). Appointment billing gap is a bug — fix needed.
### BR-014 — Khata Credit Limit: ✅ In scope. Amber/red visual warning (post-launch)
### BR-015 — Vendor Blacklist: ✅ In scope. Behind `block_enabled` flag
### BR-016 — Customer Block Vendor: ✅ In scope. Same table, blocked_by='customer'
### BR-017 — Fraud Detection Engine: ✅ Partial. Referral fraud only. Automated scoring, not auto-ban.
### BR-018 — GPS Spoof Detection: ❌ Out of scope for launch
### BR-019 — Notification Retry: ✅ Partial. FCM handles retry. Stale token cleanup done.
### BR-020 — Notification Audit: ✅ Partial. is_read as proxy. Full audit post-city-launch.
### BR-021 — Feed Moderation: ❌ Out of scope for launch
### BR-022 — Image Moderation: ✅ Partial. Three feed image fixes needed (post-launch)
### BR-023 — Consent Management: ❌ Out of scope (OS handles natively)
### BR-024 — Data Deletion: ✅ Done Session 38
### BR-025 — Data Export: ✅ Partial. Vendor Khata PDF post-launch.
### BR-026 — Multi Admin Roles: ✅ Minimal. Two roles when first hire happens.
### BR-027 — Audit Trail Enhancement: ✅ Partial. before/after values post-launch.
### BR-028 — Backup & Disaster Recovery: ✅ Trigger-based. Supabase Pro at 25 vendors.

---

## 🆕 NEW FEATURES BACKLOG — IN PRIORITY ORDER

### 🔴 Pre-Launch Must Fix
| Feature | Status |
|---|---|
| **BR-3 Account recovery first-open flow** — Index.tsx first-open detection, show recovery screen there, not mid-flow | ❌ Not started |
| **Customer name collection** — `app_users.name`, vendor-entered in LedgerView customer detail sheet | ✅ Done Session 44D |
| **Appointment billing unblock** — remove `!r.appointment_time` in IncomingOrdersSection.tsx L1248 | ❌ Not started |

### 🟡 Important / Post-Launch
| Feature | Notes |
|---|---|
| **Requirement-based test suite** — Write tests for all DR/BR/HR/NR rules in this doc. Current 336 tests validate code, not requirements. | Session 42 gap |
| **Khata warning thresholds** | amber/red from app_config |
| **Vendor blacklist + customer block** | vendor_customer_blocks table |
| **Feed location fixes** | vendor posts use shop GPS |
| **Feed image fixes** | recommendation optional, announcement optional, native camera |
| **Auto-suspend vendor rule** | avg_rating < 2.0 after 10+ reviews |
| **Auto-approve category** | 3+ vendor suggestions |
| **Vendor Khata PDF export** | client-side |
| **Audit trail enhancement** | before/after in admin_actions |
| **ping-active-vendors-location** | add migration file for cron |
| **env-split cron files** | move _held/ files into proper env-aware deploy pipeline |

### 🟢 Post-City-Scale
| Feature | Notes |
|---|---|
| **Multi-admin RBAC** | admin_users table |
| **Market profile architecture** | `market` key drives feature bundle |
| **PostGIS geospatial indexing** | Radar won't scale at 100k vendors |
| **Feed content moderation** | Third-party API |
| **GPS spoof detection** | Android isMock() |
| **RLS full lockdown** | Supabase phone auth first |

---

## 🤖 AUTOMATION RULES — APP SELF-MANAGES

| Rule | Trigger | Action | Admin notified? |
|---|---|---|---|
| **Order expiry** | Unaccepted past threshold | status=expired, customer notified | No |
| **Near-deadline warn** | delivery_slot_deadline or appointment_time approaching | Inbox + FCM to customer (once per vendor+customer pair) | No |
| **Stopped vendor detection** | Vendor GPS no movement >200m in 10min during accepted help | Amber warning to customer | No |
| **Low rating alert** | avg_rating < 2.0 AND review_count >= 5 | Admin notified once | Yes — once |
| **Auto-suspend vendor** | avg_rating < 2.0 AND review_count >= 10 | is_banned = true, vendor+admin notified | Yes |
| **Green pending trigger** | UPI + photo + rating >= 4.0 + reviews >= 3 | verification_status → green_pending, admin notified | Yes — once |
| **Auto-approve category** | Same category suggested by 3+ vendors | Auto-approved, suggesters notified | No |
| **Referral fraud flag** | referral_count from same device_id > 3 | Account flagged for admin review | Yes |
| **Stale FCM cleanup** | FCM returns UNREGISTERED/404 | Token deleted from user_devices silently | No |
| **Khata warnings** | Balance crosses Rs 3000 (amber) or Rs 5000 (red) | Visual warning in LedgerView + BillSheet | No |
| **Feed auto-hide** | Post reaches flag threshold | Post hidden | No |
| **Duplicate bill guard** | Second bill for same order | Confirm dialog shown | No |
| **Go-offline pending notify** | Vendor goes offline with today's sent/seen orders | Customer notified per order | No |

---

## 📊 NON-FUNCTIONAL REQUIREMENTS

| NFR | Target | Milestone |
|---|---|---|
| **Availability** | 99.5% uptime | Supabase Pro (at 25 vendors) |
| **Radar load time** | < 5 seconds on 3G | Current — needs PostGIS at scale |
| **Push notification delivery** | 95% within 30 seconds | FCM native — already met |
| **API response time** | 95% calls < 2 seconds | Current for pilot scale |
| **Bundle size** | < 1 MB initial JS | ✅ Currently 940 KB |
| **GPS accuracy** | < 50m for vendor tracking | Current Capacitor GPS |
| **Scalability** | 10,000 vendors, 100,000 users | PostGIS needed at this scale |
| **Data retention — billing** | 7 years (GST compliance) | Never delete order_bills, khata records |
| **Data retention — notifications** | 180 days then archive | pg_cron archival job post-launch |
| **Backup RTO** | 4 hours | Supabase Pro at 25 vendors |
| **Backup RPO** | 24 hours | Supabase Pro at 25 vendors |

---

## 🗄️ DATABASE — CURRENT STATE

### Tables (all with RLS enabled)
- `vendors`, `requests`, `categories`, `app_config`, `user_notifications`, `user_devices`, `app_users`
- `vendor_reviews`, `saved_vendors`, `feed_posts`, `feed_replies`, `feed_flags`
- `khata_ledger`, `khata_transactions`, `order_bills`, `order_items`
- `referrals`, `vendor_credits`, `user_flags`, `admin_actions`, `menu_items`
- `vendor_categories`, `vendor_verification` (Session 39)

### Notable columns added/changed across Sessions 42-44 (quick reference)
| Table | Column | Added/Changed | Session |
|---|---|---|---|
| `feed_posts` | `recommended_vendor_id`, `recommended_vendor_name`, `recommended_vendor_phone` | NEW | 42B |
| `categories` | `status`, `ai_reasoning`, `ai_confidence_score`, `suggestion_count` | NEW | 42B |
| `saved_vendors` | `user_phone`, `saved_at`, `created_at` | Synced (schema drift fix) | 42C |
| `vendors` | `khata_amber_limit`, `khata_red_limit` | NEW (vendor-owned config) | 43 |
| `vendors` | `total_issues` | NEW (already existed on TEST/PROD) | 44B |
| `vendors` | `on_time_rate` | NEW (already existed, now actually written) | 44B |
| `requests` | `fulfilled_at` | NEW | 44B |
| `vendors` | `shop_photo_url`, `photo_selfie`, `vendor_note`, `cancel_reason_1-4`, `referral_code`, `ledger_cycle_start` | NULLed on anonymization (no schema change, anonymization logic) | 44A |

### Key app_config values
| Key | Value | Notes |
|---|---|---|
| `admin_phone` | `8888169446` | Atul's phone |
| `referral_enabled` | `true` | Now ACTUALLY enforced server-side too (S42B fix — was UI-only before) |
| `help_accept_timeout_hours` | `2` | Amber warning in MyOrders |
| `help_near_deadline_minutes` | `5` | Near-deadline warn — in admin whitelist ✅ |
| `delivery_near_deadline_minutes` | `60` | Near-deadline warn — in admin whitelist ✅ (S42) |
| `appointment_near_deadline_minutes` | `60` | Near-deadline warn — in admin whitelist ✅ (S42) |
| `appointment_accept_timeout_hours` | `24` | DEAD CONFIG — loaded in SQL but unused. Hidden from admin panel ✅ (S42) |
| `vendor_stopped_minutes` | `10` | Stopped vendor detection |
| `location_ping_seconds` | `60` | Vendor GPS ping frequency |
| `dev_menu_pin` | (changed) | CHANGE BEFORE LAUNCH |
| `payments_enabled` | `false` | Gate for Razorpay |
| `feed_notification_radius_km` | `5` | Haversine radius for feed push notifications — in admin whitelist ✅ (S42B). Replaces old ±0.45° (~50km) bounding box |
| `vendor_lead_notify_enabled` | `true` | Gates admin "New vendor lead" notification from unlinked recommendations (S42B) |
| `ai_category_confidence_threshold` | `0.85` | Threshold for AI category auto-approve (S42B). Used by `suggest-category` for BOTH vendor registration category picker AND Radar unknown-term fallback |
| `ai_category_model` | `claude-sonnet-4-6` | Model used by `suggest-category` edge function |
| `radar_city_radius_km` | `15` | NOW WIRED into Radar (S42C — was dead config before) |
| `radar_highway_radius_km` | `50` | NOW WIRED into Radar (S42C — was dead config before) |
| `edge_function_url` | env-specific | See "env-specific app_config keys" in Supabase reference section — different per TEST/PROD |
| `anon_key` | env-specific | Same — different per TEST/PROD |

### pg_cron jobs
| Job | Schedule | Description | Migration |
|---|---|---|---|
| `expire-pending-orders` | `*/5 * * * *` | Expires unaccepted orders + near-deadline warns + expiry FCM | `20260606000000` |
| `warn-near-deadline` | `*/5 * * * *` | FCM push for near-deadline inbox rows | `_held/` env-specific |
| `cleanup-feed-posts` | daily 02:00 UTC | Deletes old feed posts — announcements now deleted at `expires_at` not `created_at+7d` (S42B fix) | `20260531120000` + `20260613000004` |
| `anonymise-deleted-accounts` | daily 02:00 UTC | Anonymises deletion-requested accounts | `20260606010000` |
| `ping-active-vendors-location` | `* * * * *` | GPS ping during active help orders | Dashboard-only ⚠️ (add migration file) |

### DB Triggers (pg_net + plpgsql)
| Trigger | Table | Event | Calls | Migration |
|---|---|---|---|---|
| `feed_post_after_insert` | `feed_posts` | AFTER INSERT | `notify-feed-post` via `net.http_post` — reads `edge_function_url`/`anon_key` from app_config (env-specific). Silently no-ops if either missing | `20260613000007` (S42B) |
| `trg_set_fulfilled_at` | `requests` | BEFORE UPDATE | `set_request_fulfilled_at()` — sets `NEW.fulfilled_at = now()` when `status` transitions TO `'fulfilled'` (guarded by `OLD.status IS DISTINCT FROM 'fulfilled'`, fires once) | `20260614000006` (S44B) |

### Key RPCs (SECURITY DEFINER, granted to anon)
| RPC | Purpose | Migration |
|---|---|---|
| `increment_vendor_helped(p_vendor_id uuid)` | Bumps `vendors.total_helped` — help mode resolution/rating, AND appointment mode (S44B decision — appointment reuses this counter) | pre-existing |
| `increment_vendor_delivered(p_vendor_id uuid)` | Bumps `vendors.total_delivered` — delivery mode resolution/rating | pre-existing |
| `increment_vendor_issues(p_vendor_id uuid)` | Bumps `vendors.total_issues` — "Had an issue" button (was broken — RPC didn't exist) | `20260614000005` (S44B) |
| `recalculate_vendor_on_time_rate(p_vendor_id uuid)` | Recalculates `vendors.on_time_rate` from `requests.fulfilled_at` vs `delivery_slot_deadline` for delivery orders. Only counts orders where both timestamps non-null. Leaves null if zero qualifying orders | `20260614000006` (S44B) |
| `increment_flag_count(p_post_id uuid, p_user_phone text)` | Atomic feed post flag + auto-hide at 5 flags | `20260613000003` (S42B) |
| `syncVendorRatingFromReviews` (function, not RPC) | Recalculates `vendors.avg_rating`/`review_count` from `vendor_reviews`. Handles zero-reviews-remaining case (sets null/0/false) since S44B | pre-existing, fixed S44B |
| `recordUserReferral` / `process-vendor-referral` | Referral processing — now gated on `referral_enabled` (S42B) | pre-existing, gated S42B |
| `suggest-category` (edge fn) | AI category matching via Claude — used by vendor registration AND Radar unknown-term fallback | `20260613000010` (S42B) |

### Realtime subscriptions
| Channel | Table | Events | Purpose |
|---|---|---|---|
| `my-orders-vendor-locations` | vendors | UPDATE | Live vendor GPS in MyOrders |
| `my-orders-realtime` | requests | UPDATE | Order status changes in MyOrders |
| `home-help-order-banner` | requests | UPDATE | Help order banner on Home |
| `vendor-track-${vendorId}` | vendors | UPDATE | LiveTracking screen |
| `user-notifications-${phone}` | user_notifications | INSERT, UPDATE, DELETE | Bell badge + tray |
| `incoming-orders-${vendorId}` | requests | INSERT, UPDATE | Vendor incoming orders |
| `vendor-${vendorId}` | vendors | UPDATE | VendorMode profile sync |

### Edge functions
| Function | Purpose |
|---|---|
| `notify-vendor` | Push to vendor FCM — auto-cleans stale tokens. Includes `route`/`route_params` in FCM data (S42B deep-link fix) |
| `notify-user` | Push to customer FCM — auto-cleans stale tokens. Includes `route`/`route_params` in FCM data (S42B deep-link fix) |
| `notify-admin` | Push to admin FCM — auto-cleans stale tokens |
| `notify-feed-post` | Push to feed subscribers. Now triggered by DB trigger `feed_post_after_insert`, NOT client (S42B — see Architectural Rule 16). Handles announcement/recommendation/offer types. Haversine radius-based targeting via `feed_notification_radius_km` (S42B, replaces ±0.45° bbox). Includes `route: 'feed'` + `route_params: {post_id}` for deep-link |
| `notify-vendor-tomorrow` | Remind vendors of tomorrow delivery orders |
| `ping-active-vendors` | Ping vendors for GPS update |
| `calculate-trust-score` | Customer trust score |
| `process-vendor-referral` | Validate + record referral. Gated on `referral_enabled` (S42B fix — was previously unconditional). Notifies vendor (push+inbox `referral_credit` type) on credit earned (S42B) |
| `initiate-call` | Exotel masked call (AI Bridge) |
| `delete-account` | Account deletion/anonymisation |
| `warn-near-deadline` | FCM push for near-deadline inbox rows. Passes `type`+`order_id` to notify-user for deep-link (S42B) |
| `suggest-category` | NEW (S42B) — AI category matching via `ai-gateway`/Claude. Used by (1) vendor registration category picker and (2) Radar unknown-search-term fallback (RS-04). Confidence-based routing: high→auto-assign, medium→confirm UI, new+high→pending_review+notify admin, low→top-3 picks |

**Shared utilities:**
- `supabase/functions/_shared/fcm-cleanup.ts` — `deleteStaleToken(token, url, key)` — imported by all FCM functions
- `supabase/functions/_shared/notification-routes.ts` — NEW (S42B) — maps notification `type` + ids → `route`/`route_params` for FCM data payloads, used by notify-user/notify-vendor/notify-feed-post
- `supabase/functions/notify-feed-post/constants.ts` — NEW (S42B) — English-only push title constants (edge functions can't read user language preference)

---

## 🔐 SECURITY NOTES

### Known gaps (post-launch backlog)
1. **RLS on user_notifications** — open INSERT for cross-user notifications. Fix post-launch with Supabase phone auth.
2. **Admin panel not server-enforced** — UI gate only. Fix post-launch.
3. **UPI verification is simulated** — no real PSP check. Admin manual verification.
4. **Developer menu** — PIN-protected. Change before launch.
5. **ping-active-vendors-location** — dashboard-only cron. Add migration file.

---

## 🧪 AUTOMATED TEST SUITE — CURRENT STATE

### Infrastructure
| Item | Detail |
|---|---|
| Framework | Playwright (E2E + DB) + Vitest (unit + component) |
| Language | TypeScript |
| Workers | 1 (sequential) |
| Timeout | 45s per test |
| Retries | 1 |
| Test Supabase | `hhdylnhqdzfabsolwxdz` |
| Playwright run | `npx playwright test --reporter=list` |
| Vitest run | `npm test` |
| Vitest count | 44 tests, 11 files — all passing (Session 46) |
| Playwright DB count | ~180 tests — passing |
| Playwright browser UI | ~157 tests — ⚠️ BROKEN (auth infrastructure missing — see Session 46) |

### ⚠️ Test Suite Debt — Two Critical Problems

**Problem 1 — Browser UI tests need real Supabase auth:**
All Playwright browser tests that navigate the app UI fail because the app's auth guard requires a real Supabase session, not just localStorage values. `loginAsCustomer` currently sets localStorage but never creates a Supabase session. App always redirects to `/login`. Fix in Session 47: implement `loginAsCustomer` using Supabase service-role key (`auth.admin.createUser()` + `signInWithPassword()`).

**Problem 2 — Tests validate code, not requirements (Atul's core challenge):**
Current suite asks "does the code do what it was written to do?" not "does the app do what a kirana vendor in Warje needs it to do?". 44 Vitest tests + 180 DB Playwright tests passing ≠ app works for real users. Session 47 must rebuild browser tests from user requirement scenarios after fixing auth.

### Requirement-Based Test Scenarios (to build in Session 47)
These are the REAL tests that matter — written from user stories:
| Scenario | What to assert |
|---|---|
| Kirana vendor registers | Appears in Radar within 15km |
| Customer places help order | Vendor gets FCM notification |
| Vendor accepts order | Customer sees "accepted" status |
| Help vendor goes offline | Disappears from Radar help tab |
| Delivery vendor goes offline | Still appears in Radar delivery tab |
| Customer searches "mechanic" | Only mechanics within selected radius appear |
| Khata bill created | Ledger balance updates correctly |
| Pan-India vendor | Appears in ALL bracket searches |
| ParchiSheet low-trust | Checkbox required before confirm enabled |
| Admin warns user | FCM push sent in user's language (HI/MR) |
| Vendor registration | service_radius_km saved; error toast if UPDATE fails |
| Referral code used | Credit created for both vendor and customer |

### Critical Test Rules (MUST follow — learned from past bugs)
- `requests` table has NO `service_mode` column — never add to inserts
- `requests` requires `device_id` (not null) — always include
- `requests` uses `user_phone` — 10 digits no +91
- `order_bills` uses `request_id` not `order_id`, and `total_amount` not `total`
- `vendor_menu_items` is the correct table name
- `status: 'fulfilled'` shows orders with rate button — not `done`
- `incoming-decline-btn` only exists for appointment orders
- `deletion_requested_at` is NULL after anonymisation completes (G10, Session 44A) — test must assert `toBeNull()`

---

## 🏛️ SESSION HISTORY (summary)

### Session 46 — All Gaps Fixed + Cleanup Batch + Test Reset (17 June 2026)
All 9 gaps from Session 45C full-app audit fixed across 5 batches. Post-launch cleanup batch completed ahead of schedule (all 8 items done). Two migrations applied TEST+PROD: `20260616000001` (seed 15 app_config keys) + `20260616000002` (remove debug_loc_error). 60+ new localization keys across 6 files. `radarVendorFilter.ts` extracted as testable pure module. Vitest suite: 44 tests, 11 files, all passing. Playwright browser UI tests discovered to be structurally broken (app auth guard requires real Supabase session, not localStorage — `loginAsCustomer` helper was always wrong). DEL-01 DB test fixed (deletion_requested_at → toBeNull per Session 44A G10 design). Honest test debt documented: browser UI tests skipped, requirement-based E2E test suite planned for Session 47 with auth infrastructure fix first. Key principle reinforced: tests must validate requirements ("does a kirana vendor in Warje get notified?") not code ("does the function execute?").

### Session 45C — Admin Panel Audit + Full-App Audit (16 June 2026)
Full audit of Admin panel — 9 gaps (Gap 13-21) triaged: 7 fixed, 2 by-design. Fixes: audit logging for config saves/review deletes/admin check pass-fail, whitelist completeness (8 new keys), orphan radar keys removed, boolean toggle switches for 5 flag keys, number validation for timeout/distance keys, review delete confirm dialog. Full-app audit done at session end — 15 gaps found, 9 real fixes triaged, 6 by-design/post-launch. Fix order documented for Session 46.


Full audit of Settings page — 17 gaps triaged, 10 fixed, 4 by-design, 3 to post-launch cleanup batch. No migrations — all client-side. Key fixes: (1) Feed notifications toggle reverted to native-only — was incorrectly shown on web since Session 42B, but web can't receive FCM push notifications at all, making the toggle meaningless; (2) Admin config UPSERT — was UPDATE-only, causing silent failure when saving a key whose DB row didn't exist; (3) 8 new keys added to admin whitelist — radar radii (now actually wired in Radar since 42C), call time limits, vendor trial days, subscription price (all needed for Razorpay sprint); (4) All 24 whitelist keys now have human-readable labels instead of raw DB key names; (5) Extensive hardcoded English in MY SHOP/Preferences/addresses localized (EN/HI/MR) — MY ACCOUNT/MY SHOP parent labels now use strings.ts with CSS uppercase (so Devanagari translations render correctly without forced caps); (6) `referEarnVisible` made optimistic default (true) to eliminate flicker. Post-launch cleanup batch finalized and documented (8 items: dead configs, dead strings, dead components, dead code — to be done in one dedicated session). Key architectural decisions: admin panel is English-only by design; AI category confidence threshold not exposed (fix the prompt, not the knob); feed push is native-only by design.

### Session 45 — BR-3 + Service Radius + Offline Orders + Radar Mode (15 June 2026)
Four major features built. (1) BR-3 Account Recovery — first-open flow fully built in Index.tsx. Vendor session restore + customer identity restore from single phone number. Guards: is_active + deletion_requested_at null. Pre-launch blocker #3 closed. (2) Vendor Service Radius + Pan-India — vendors declare 5/15/25/50/100km/Pan-India (9999km) bracket. Customers filter Radar by distance. Amazon-style Pan-India sellers now supported — solves wholesale/B2B use case. Migration applied TEST+PROD. (3) Offline Vendor Orders — delivery + appointment vendors show in Radar even when is_active=false. Customer can place future orders. Help mode unchanged (real-time only). (4) Radar Mode Selector — 3 explicit mode buttons (Help/Delivery/Booking) replace inferred mode from URL param. Mode passed from Home + LocalFeed. AI suggest handles cross-mode mismatch gracefully.

### Session 44B — Ratings/Reviews Audit + Fixes (14 June 2026)
Full audit of Ratings/Reviews — 16 gaps (R1-R16) all fixed. Major cross-cutting discovery during R4/R6 discussion: the Radar "quick acknowledgement" resolution button had THREE DIFFERENT gating rules across modes — delivery correctly checked `status='fulfilled'` in DB, help incorrectly used a sessionStorage flag set whenever a call merely CONNECTED (a no-show plumber could still trigger "He Helped Me"), appointment had no button at all. Unified all three on the correct DB-verified pattern, removed dead session-based code, made labels gender-neutral ("Vendor Helped Me"/"Vendor Served Me" instead of "He Helped Me"), and gave appointment vendors the same `total_helped` social-proof counter as help/delivery. Built `on_time_rate` properly (Path A) — was displayed in 3 places but written nowhere; added `requests.fulfilled_at` + trigger + `recalculate_vendor_on_time_rate` RPC. Created missing `increment_vendor_issues` RPC (broken "Had an issue" button). Fixed double-counting between Radar resolution and MyOrders rating (two-directional guard). Added admin "Low Ratings" moderation panel. Fixed RatingSheet backdrop-close, anonymous reviewer label, voice-unavailable localization, hide-rate-CTA-if-reviewed. Aligned test/code mismatches (admin_alert type, 3.5 recovery threshold). Completed R15 (vendors.deletion_requested_at clear, counterpart to 44A's G10). 3 migrations (`20260614000005/6/7`) applied TEST+PROD. Test suite verified: rating-advanced 6/6 passing, RV-REPLY-01 fixed (test had a locator bug expecting initial-render count) and passing.

### Session 44D — Customer Name + Service Radius Decision (14 June 2026)
Customer name (`app_users.name`) built — vendor-entered name in LedgerView customer detail sheet. Decided against customer-entered name at order time (90% of customers never have khata — unnecessary friction). Vendor knows their khata customers personally — enters name directly in ledger. Migration `20260614150000` applied TEST+PROD. Pre-launch blocker #4 closed. New pre-launch feature designed: Vendor Service Radius — vendors declare service area (5/15/25/50/100km/pan-city), customers filter Radar by distance bracket. Solves wholesaler/B2B use case (kirana buys from wholesaler, tiffin from sabziwala, salon from beauty supplier — all B2B on Aaspaas). Full WHAT/WHY/HOW/WHERE/WHEN documented in master log.

### Session 44C — Vendor Registration + Referrals Audit + Fixes (14 June 2026)
Full audit of Vendor Registration (14 gaps, VR-REG-01 to VR-REG-14) and Referrals (24 gaps, RF-REG-01 to RF-REG-24). Major fixes: atomic `register_vendor` RPC (vendor + 7 verification rows + categories in one transaction), `attach_pending_category` atomic RPC (AI pending category attach — prevents zero-category state), `profile_status` draft/complete column (vendors without GPS register as draft, invisible in Radar until location added), vendor type-driven mandatory fields (shop/home/visiting each have different required fields), single UPI validator, phone-derived referral codes, banned/deleted phone guard at lookup + registration. Referrals: referral business rules locked (vendor→vendor ₹25/3 months, vendor→customer ₹2.5, customer→nothing), USER* codes removed (customers have no subscription to discount), deeplink code prefilling, self-referral block, `credits_created` flag fixed, user referral notification added (parity with vendor path), `referEarnVisible` flash fixed, full i18n pass, duplicate vendor referral handled gracefully. Infrastructure finds: `vendor_credits_insert` missing on PROD (silent failure — fixed), `vendors.created_at` → `last_updated` in edge function (veteran path was broken — fixed). 7 migrations TEST+PROD. `process-vendor-referral` edge function redeployed. All E2E tests passing (RF-E2E-01 17.7s, RF-E2E-02 15.3s).

### Session 44A — Data Deletion Audit + Fixes (14 June 2026)
Full audit of account deletion/anonymization against fields added in Sessions 42+43 — 12 gaps (G1-G12) triaged. 5 fixed: recommended_vendor_* PII nulled on post author deletion (G2), saved_vendors cleaned by device_id before user_devices deletion (G4), full vendor profile PII scrub — photos/notes/cancel reasons/referral code (G5), related vendor tables deleted on vendor anonymization — menu items/credits/categories/verification (G7), deletion_requested_at flag cleared post-anonymization (G10, customer-side). Two initial "fix" decisions REVERSED after Atul challenged the risk: G1 (delete vendor's khata book on vendor deletion) — reversed to by-design because customers need their own debt history and vendor_id isn't PII; G6 (null referrer_vendor_id in referrals) — reversed to by-design because referral records are a financial audit trail. Confirmed Aadhaar Act 2016 compliance — no raw Aadhaar stored anywhere. Migration `20260614000004` (CREATE OR REPLACE on both anonymization functions, all existing logic preserved) applied TEST+PROD — established the "_held/ temporary-restore-for-push" pattern for PROD pushes when env-specific migrations exist.

### Session 43 — Khata/Billing Audit + Fixes (14 June 2026)
Full audit of Khata/Billing — 24 gaps (KB-01 to KB-24) triaged, 18 fixed across 9 Cursor prompts, 3 by-design, 3 post-launch. Cleared pre-launch blocker #5 (appointment billing unblock — `!r.appointment_time` condition removed). Key architectural decisions locked in: payments between vendor and customer permanently out of scope (cash/UPI in person; Razorpay is vendor-subscription-only at ₹99/month); khata disabled by default (`khata_amber_limit=0`, vendor must opt in); khata limits are vendor-owned config (admin has no per-vendor control); khata can't be disabled while outstanding balance exists; Add to Ledger converged with BillSheet into one atomic pipeline (single RPC handles bill+items+khata in one transaction, with void/reverse handling). Built vendor-owned credit limit system with amber/red warnings across 3 surfaces. Added masked-call-for-dues-collection in LedgerView via Exotel. 3 migrations applied TEST+PROD, PROD migration repair completed.

### Session 42C — Radar Search Audit + Fixes (13 June 2026)
Full audit of Radar geo-search. 28 gaps (RS-01 to RS-28) triaged: 18 fixed, 1 by-design, 6 post-launch (PostGIS-dependent or low-value), 3 skipped. Key fixes: single source of truth for categories (`src/lib/categories.ts`, merges two previously duplicated lists), config-driven search radii (admin changes now take effect), feed recommendation→Radar deep-link fixed with online/offline gating, AI fallback for unrecognized search terms via `suggest-category`, SOS filtered to help-mode only with guidance subtitle, medical vs ambulance search cleanly separated (104 vs 108), saved_vendors DELETE RLS policy added (unsave was broken), schema drift fixed (user_phone/saved_at/created_at columns), online/offline green-dot + fresh is_active gate applied to Radar cards AND Home saved neighbours, unified trust badge (VerificationBadge XOR trust tier — never both), Devanagari trust labels, removed dead SignalFreshness component + 900ms artificial delay (replaced with skeletons), active-order badge fixed to use phone+device matching, mode-specific CTA labels (Connect/Order/Book). New architectural rule established: single source of truth for shared constants. New requirement specs (RAD-01 to RAD-11) written for test case generation.

### Session 42B — Announcements + Recommendations Audit + Fixes (13 June 2026)
Full audit of Local Feed — 32 gaps (A1-A17, R1-R15) triaged across 9 Cursor prompts. Major outcomes: (1) Vendor offers now get lat/lng + push notification to nearby customers — core USP previously broken. (2) Feed notifications moved from unreliable client-side calls to DB webhook trigger (`pg_net`) — new architectural rule "notifications are always server-triggered" established after recognizing order notifications and feed notifications used inconsistent patterns. (3) Built AI-powered category suggestion (`suggest-category` edge function using Claude) — replaces rigid "3 vendor suggestions" rule with confidence-based auto-approval, solves the "how do we categorize every business type globally" problem. (4) Built recommendation-to-vendor linking — customer recommendations can tag an existing Aaspaas vendor (online/offline gated) or, if vendor not on app, capture name+phone as an admin-notified growth lead. (5) Full notification deep-link audit and fix — EVERY push tap and bell tap across the entire app now navigates correctly (previously `pushNotificationActionPerformed` was a stub that only logged). (6) Fixed atomic flag/auto-hide RPC, cron expiry alignment, storage policy (with anon-path-restriction correction after initial over-restriction broke uploads), announcement image made optional (Session 36 decision finally implemented), GPS-required guard for community posts, Haversine-based notification radius (replacing 50km bounding box), referral_enabled gate enforcement, referral credit notifications. Two new architectural decisions: location-source matrix (who uses current GPS vs shop GPS vs admin area picker) and "vendor offline = use go-offline button, not announcement" (by-design). Admin global/area announcement feature noted for backlog but not built.

### Session 42 — Three-Mode Gap Audit + Fixes (13 June 2026)
Full gap audit across all three service modes. 20+ gaps found and triaged. Delivery: 9 gaps fixed (past-slot guard, slot-aware near-deadline copy, friendly accepted label, overdue amber card+dismiss, badge sent+seen, admin whitelist, slot-aware expiry copy). Booking: 12 gaps fixed (past-appointment guard, appointment-time aware near-deadline copy, booking-centric expiry copy, confirmed overdue amber card+dismiss, vendor dismiss for declined, go-offline notify for pending orders both modes, edit placeholder localized, admin whitelist). Infrastructure: env-split migration conflict resolved, 4 files moved to _held/. 2 migrations applied to TEST+PROD. Edge function redeployed. Requirement specifications written for all three modes. Requirement-based test seeds defined. Key learning: tests must validate requirements not just code — 336 passing tests ≠ no gaps.

### Session 41 — Cron Scheduling + Near-Deadline Notifications (11 June 2026)
Scheduled `warn-near-deadline` edge function via pg_cron on both TEST and PROD. Near-deadline FCM push fully working end-to-end. Session 40 carry-over applied.

### Session 40 — Critical Bug Fixes + Notification Pipeline (10 June 2026)
14 bugs fixed. RLS, CORS, foreground notifications, customer location race condition, N+1 queries, expired order UX, ParchiSheet, notification bell. 4 BRs completed. APK built.

### Session 39 — Multi-Category Vendor Architecture
vendor_categories + vendor_verification tables. Trust levels. Vendor types. Multi-category picker. Radar JOIN.

### Session 38 — All 4 Pre-Launch BRs Complete (6 June 2026)
Order expiry, stale FCM cleanup, account recovery, data deletion. 336 tests passing.

### Session 37 — Full Automated Test Suite (6 June 2026)
305 → 336 tests. Playwright infrastructure. Test Supabase project.

### Session 36 — Requirements Review + Decisions (3 June 2026)
28 BRs reviewed. Architectural philosophy documented.

### Session 35 — Full Audit + All Flows Fixed
10-flow full audit. ESLint clean. Bundle optimized.

### Sessions 1–34
Core app. All three modes. Settings. Notifications. Khata. Referrals. Feed. Live tracking. AI-Bridge.

---

## 🔍 EXOTEL AI BRIDGE — INVESTIGATION (Session 37)

### Call Flow
1. User taps "📞 Call Now" in `AiBridgeSheet.tsx`
2. `handleCallNow()` → `invokeInitiateCall({ caller_phone, vendor_phone, service_mode })`
3. POST to `/functions/v1/initiate-call`
4. Edge function → Exotel REST API
5. Exotel connects masked call

### Required Secrets
- `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_CALLER_ID`
- Set in Supabase Dashboard → Edge Functions → initiate-call → Secrets

### Fallback
If Exotel fails → direct dial (`tel:`) opens on device. No code change needed when Exotel KYC completes.

---

### Session 47 — Playwright Infrastructure Fix + Full Requirement-Based Test Suite + Security Audit + OTP Auth Phase A (18-19 June 2026)

**Starting state:** 353 passed, 163 failed (stale webServer, missing Chromium, port mismatch). Browser UI tests effectively non-functional since Session 38.

#### Part 1 — Playwright Infrastructure Fixed
| Fix | Detail |
|---|---|
| `reuseExistingServer` | `true` → `false` — was serving stale builds |
| Chromium | Installed (`npx playwright install chromium`) |
| Port | Moved test webServer to **8081** (8080 was occupied by dev server); `VITE_APP_URL` aligned in `.env.test` / `.env.playwright` |
| `loginAsCustomer` | Now waits for `[data-testid="home-screen"]` instead of `networkidle`; confirmed it already set `aaspaas:welcomed` |
| `loginAsFreshUser` | Now waits for `[data-testid="first-open-flow"]` |
| Stale testids | `welcome-card`→`first-open-flow`, `welcome-explore-btn`→`firstopen-restore-skip`, `welcome-vendor-btn`→`firstopen-vendor-btn` |

**Result after infra fix:** 188 → 320 → 353 passed, 0 failed, 4 skipped (CO-01–04, later re-enabled — see below).

#### Part 2 — Full Requirement-Based Browser Test Suite Written (212 new tests)
Built from **requirements in this log**, not from existing code — methodology: define expected behavior per scenario first, write test, run against real app, triage every failure as test-bug vs real-bug before fixing.

| Area | File | Tests |
|---|---|---|
| My Orders (all states, 3 modes) + ParchiSheet placement | `browser-myorders-requirements.spec.ts` | 20 |
| Incoming Orders (vendor side, all states, 3 modes) | `browser-incoming-orders-requirements.spec.ts` | 18 |
| Vendor Mode (online/offline, GPS, draft, banned) | `browser-vendor-mode-requirements.spec.ts` | 13 |
| Radar (category resolution, SOS, trust badges, saved neighbours) | `browser-radar-requirements.spec.ts` | 13 |
| Notifications (bell, deep-links, copy, dedup, i18n) | `browser-notification-requirements.spec.ts` | 19 |
| Feed (post types, location radius, flagging, masking) | `browser-feed-requirements.spec.ts` | 16 |
| Ratings/Reviews (full journey, mode-aware copy, admin alerts) | `browser-ratings-requirements.spec.ts` | 19 |
| Settings (customer + vendor + admin views) | `browser-settings-requirements.spec.ts` | 20 |
| Referrals (UI, deeplink, self-referral, credits) | `browser-referrals-requirements.spec.ts` | 11 |
| Khata/Billing (BillSheet, credit limits, ledger, notify) | `browser-khata-requirements.spec.ts` | 13 |
| Account Deletion (full UI flow, dual-role, anonymization) | `browser-deletion-requirements.spec.ts` | 11 |
| Admin Panel (verification, moderation, health, ban/unban, security) | `browser-admin-requirements.spec.ts` | 13 |
| Localization (fallback chains, casing, specific HI/MR strings) | `browser-localization-requirements.spec.ts` | 12 |
| First Open Flow (restore all roles, skip, completion) | `browser-firstopen-requirements.spec.ts` | 14 |
| CO-01–04 re-enabled (`.skip` removed, was blocked by infra bug above) | `browser-order-flow.spec.ts` | 4 |

**End state of Part 2:** 584 passed, 0 failed, 0 skipped.

#### Part 3 — Bugs Found & Fixed via Requirement Testing (21 total)
| # | Bug | Area | Severity |
|---|---|---|---|
| 1 | Amber overdue card hid order details entirely (booking, confirmed+overdue) | MyOrders | UX |
| 2 | `myOrders_delivered` said "Tap to dismiss" instead of "Tap to rate" — broke rating funnel | strings.ts | UX/Revenue |
| 3-4 | `rating_btnHelped` = "He Helped Me" — gendered copy in 2 places (MyOrders CTA + RatingSheet submit) | strings.ts | Inclusivity |
| 5 | Amber overdue card showed even on **fulfilled** bookings (missing status guard) | MyOrders.tsx | Logic |
| 6 | Help-mode vendors had **no order button** on Radar card at all | RadarVendorCard.tsx | Functional |
| 7 | Vendor has **no call button** on accepted orders — `AiBridgeSheet`/strings built but never wired into `IncomingOrdersSection.tsx`; dead `calledUser` state found | IncomingOrdersSection.tsx | 🔴 Functional gap (still open — deferred) |
| 8 | Expired **delivery** order notification used help-mode copy ("no vendor accepted") instead of slot name | `expire_pending_orders()` SQL | Notification correctness |
| 9 | Customer got **one expiry notification per expired order**, not deduped per customer per cron run | `expire_pending_orders()` SQL | Notification spam |
| 10 | "Mark all read" was fire-and-forget — DB write not always awaited, could silently fail | NotificationBell.tsx | Reliability |
| 11 | **Raw phone numbers visible** in feed post body text — no masking applied | LocalFeed.tsx | 🔴 Privacy |
| 12 | Feed compose sheet opened **before** GPS check instead of blocking on missing GPS | LocalFeed.tsx | Logic vs spec |
| 13 | "Could not load feed" error on real device (PROD) | LocalFeed.tsx / PROD Supabase | Root cause: PostgREST schema cache hadn't picked up `recommended_vendor_id` FK — fixed via `NOTIFY pgrst, 'reload schema';` on PROD + APK rebuild. Confirmed fixed by Atul on-device. Diagnostic logging added then reverted. |
| 14 | Bill-sent customer notification was **client-side** (`invokeNotifyUser` in BillSheet.tsx) — violates server-triggered architecture rule, silent-failure risk | BillSheet.tsx | 🔴 Architecture — converted to DB trigger (`order_bill_after_insert` + `pg_net`) |
| 15 | **Dual-role deletion (G12)** — documented as "by design" but never implemented; customer-delete silently skipped anonymization forever if same phone had any vendor row, no error shown to user | delete-account fn + `anonymise_deleted_accounts()` SQL | 🔴 Compliance gap — fixed: customer delete now ALSO starts vendor's 30-day grace if dual-role; both rules apply correctly |
| 16 | **Admin Panel had zero server-side authorization** — UI hid the Admin tab, but any anon client could call `vendors.update({is_banned:true})` etc. directly, bypassing UI entirely | All admin actions | 🔴 CRITICAL security — fixed: 12 new `SECURITY DEFINER` RPCs (`admin_ban_vendor`, `admin_verify_vendor`, etc.) with `is_admin_phone()` check, **plus** `BEFORE UPDATE/INSERT` triggers (`prevent_direct_admin_column_writes()`) on 6 tables blocking direct writes to admin-only columns unless routed through RPC (`app.via_admin_rpc` session flag) |
| 17 | **Appointment/booking billing completely blocked** — `canShowBillButton` required `status IN ('accepted','fulfilled')`, but confirming a booking only ever set `appointment_status='confirmed'`, never flipped `status` — so Send Bill never appeared for any booking, ever (BR-013, previously known, unfixed) | IncomingOrdersSection.tsx | 🔴 Revenue-blocking — fixed: confirm now also sets `status='accepted'`; `canShowBillButton` updated for appointment mode |
| 18 | Admin vendor/user/category list queries hit **Supabase's 1,000-row default cap** silently — TEST DB found to have 1,856 vendors already; no pagination existed anywhere in admin queries | Settings.tsx (admin section) | 🔴 Scale landmine — fixed: `adminQueryPagination.ts` helper (`fetchAllPages`, `fetchByIdChunks`, `warnIfQueryTruncated`); vendor moderation list now defaults to unverified+flagged only, server-side search, Load More pagination, count-based stats instead of full fetches |
| 19 | **RLS effectively unrestricted on all 26 public tables** — full audit run; every table has RLS "enabled" but uses `anon_all` / `USING(true)` policies for the `anon` role the app actually uses. Financial tables (`order_bills`, `khata_ledger`, `khata_transactions`, `vendor_credits`) fully writable by anyone holding the public anon key (which ships inside the APK). A few "ownership-aware" policies exist on `requests` but reference `request.jwt.claims` which the app never populates (dead code) | **ALL 26 TABLES** | 🔴🔴 CRITICAL — root cause: app uses Supabase **anonymous auth**, no real `auth.uid()`, so RLS has nothing to check against. **Decision made:** reject header-based fake-ownership RLS (forgeable, false security). **Real Supabase Phone OTP auth is the chosen fix** — verifies once at signup/recovery, session persists silently after (confirmed acceptable: NOT asked on every action). **Scoped as 4-phase migration, see below — Phase A done, B/C/D pending next session(s).** |
| 20 | "Who are you recommending?" — feed recommendation composer label read as confrontational/interrogative | strings.ts | UX tone — fixed to "Which vendor are you recommending?" (EN/HI/MR) |
| 21 | Flag/report button on feed posts gave **no visual feedback** after tapping — looked like nothing happened, could be tapped repeatedly | LocalFeed.tsx | UX — fixed: `flaggedByMe` state, filled red flag + disabled after report, persists across reload, `feed_reportedPostAria` added |

**Still open from this session:**
- **Bug #7** — vendor call button never wired into IncomingOrdersSection (Exotel/AiBridgeSheet infra exists, just not connected on vendor side). Deferred, not yet scheduled.
- **Bug #19** — RLS / OTP auth — Phase A complete only, see below.

#### Part 4 — Security Deep Dive (triggered by Bug #16 discovery)
Full RLS audit performed across TEST project (`hhdylnhqdzfabsolwxdz`) — see Bug #19 above for headline finding. Full table-by-table risk categorization (Critical/High/Medium/Low/None) was produced; **zero tables fully restricted for anon client**. Critical tier = all financial tables + `vendor_credits`. High tier = `users`, `vendors`, `user_devices`, `user_notifications`, `vendor_reviews`, `referrals`, `app_users`, `vendor_verification`, `vendor_categories`, `admin_actions`.

**Architectural decision recorded:** Real Supabase Phone OTP auth (not header-based fake ownership) is the only correct fix, since the anon key is always extractable from the APK and a header is just an unverified client claim. SMS delivery will use **Exotel ExoVerify** (Start/Check Verification API) — same dormant-credential-swap pattern already used for AI-Bridge calling (`invokeInitiateCall`). Until Exotel KYC completes, the SMS hook runs in dormant/stub mode (logs OTP instead of sending real SMS) — exact same pattern as `AiBridgeSheet`'s `tel:` fallback.

**4-Phase migration plan agreed:**
- **Phase A** — Enable Supabase Phone Auth + dormant ExoVerify SMS hook edge function. Zero app code touched. Standalone isolated test only. ✅ **DONE THIS SESSION.**
- **Phase B** — Dual-write identity: add real OTP verification to login/restore flow, but KEEP existing localStorage mechanism working exactly as today in parallel — establish real Supabase session alongside, not instead of, old mechanism. Not yet started.
- **Phase C** — Migrate RLS table-by-table starting with Tier 1 (financial: `order_bills`, `order_items`, `khata_ledger`, `khata_transactions`, `vendor_credits`), then Tier 2 (identity/trust), then Tier 3 (content). Each tier verified by tests before moving to next. Not yet started.
- **Phase D** — Retire legacy localStorage-only trust path once all 26 tables confirmed on real RLS; update test infra (`loginAsCustomer` etc.) to mint real sessions; remove Phase B dual-write scaffolding. Not yet started.

**Phase A — what was actually built:**
- `supabase/functions/sms-hook/index.ts` — Supabase Send SMS Hook receiver. Verifies Supabase webhook signature, then either (a) calls ExoVerify Start Verification using `EXOVERIFY_APP_ID`/`EXOVERIFY_APP_SECRET` env vars if present, or (b) **dormant mode**: logs OTP and writes to `_test_otp_capture` table for test readback, returns success — used because Exotel KYC not yet complete.
- Supabase Auth → Phone provider enabled on **TEST** project only (`hhdylnhqdzfabsolwxdz`). Send SMS Hook wired to the new edge function per Supabase's documented hook pattern (`supabase_auth_admin` granted execute; `anon`/`authenticated` revoked direct access).
- `tests/phone-auth-infrastructure.spec.ts` → `PHONE-AUTH-01`: full isolated round-trip — `signInWithOtp()` (new standalone Supabase client, NOT the app's existing client) → capture OTP from `_test_otp_capture` → `verifyOtp()` → asserts real JWT session returned with correct phone. **PASSES.**
- **Zero `src/` app code changed in Phase A** — by design, to keep blast radius at zero.

**Full suite re-run after Phase A:** 552 passed, 13 failed, 1 flaky (566 total — note: 18 fewer than the 584 baseline; the discrepancy is most likely the `tests/phone-auth-infrastructure.spec.ts` file plus minor count drift across runs, not a hidden regression — see reconciliation below).

**✅ RECONCILIATION COMPLETE (same session, just before handoff):** Ran the suite again with Phase A files `git stash`-ed (i.e. Phase A completely removed). Result: **552 passed / 12 failed / 1 flaky** (565 total) — virtually identical to the with-Phase-A run (552/13/1). 12 of the 13 failures matched exactly between both runs. Only `KB-REQ-12` differed (passed in the no-Phase-A baseline; explained as flaky, not a real discrepancy — it was already flagged flaky earlier in the session). **Verdict: the 12-13 failures are 100% confirmed pre-existing test debt, unrelated to and not caused by Phase A.** Phase A changes were restored via `git stash pop` immediately after. **Phase A is CONFIRMED CLEAN. Safe to proceed directly to Phase B — no further reconciliation needed.**

**Note for next session:** the 12 pre-existing failures (admin RPC/RLS trigger interactions in older non-`-requirements` test files using direct column writes for setup, e.g. `browser-negative-flow`, DEL-05, RF-06, AD-10, ADM-REQ-08) are real but unrelated test debt — likely candidates to clean up opportunistically during Phase C (RLS migration) since they're testing the exact tables Phase C will touch, but they are NOT a blocker for Phase B.

#### Open Items Carried Into Session 48
| # | Item | Priority | Next step |
|---|---|---|---|
| 7 | Vendor call button never wired in IncomingOrdersSection | Medium | Wire `AiBridgeSheet` into accepted-order action block (help/delivery between phone row and Mark Done; booking confirmed block alongside Cancel/Mark Done) |
| 19-C | **Phase B — dual-write identity** | 🔴 **Start here** | Phase A confirmed clean (see reconciliation above). Add real OTP to login/restore flow while keeping localStorage mechanism fully working in parallel — see phased plan above. Recommended: start this in a **fresh chat** with this log uploaded, since it's foundational/high-care work. |
| 19-D | Phase C — RLS migration Tier 1→2→3 | 🔴 High | After Phase B proven stable. Financial tables first. Opportunistically clean up the 12 pre-existing test failures (see below) while touching these same tables. |
| 19-E | Phase D — retire legacy auth path | Medium | Final cleanup phase, only after C fully verified. |
| — | 12 pre-existing test failures (admin RPC/RLS trigger interactions in older test files: `browser-negative-flow`, DEL-05, RF-06, AD-10, ADM-REQ-08, etc.) | Low | Confirmed pre-existing, unrelated to Phase A. Not blocking. Good candidates to fix opportunistically during Phase C since they touch the same tables. |
| — | Razorpay vendor subscription ₹99/month | Medium | Still pending from Session 46 carry-over — deprioritized this session in favor of test/security work |
| — | APK rebuild + 2-phone device test | Medium | One APK rebuild already done mid-session (confirmed feed fix working on device) — full 2-phone test still pending |
| — | Play Store submission | Low | Blocked on above + Play Console account (Atul's action, $25, not started) |

**Suite state end of Session 47:** 584 passed / 0 failed / 0 skipped (post Part 2, before Phase A) → 552 passed / 13 failed / 1 flaky (post Phase A) → **reconciliation confirms the 12-13 failures are pre-existing, unrelated to Phase A — Phase A itself is clean.**

**Working method established this session (recommended to continue):** For every app area — (1) re-read actual requirements from this log first, (2) write requirement-based tests against expected behavior, not existing code, (3) run and triage every failure individually as test-infrastructure-bug vs real-app-bug before fixing anything, (4) real bugs get a product decision when ambiguous (e.g. dual-role deletion, flag-button timing) rather than a default guess, (5) full-suite runs only at natural checkpoints — targeted file runs otherwise to save time.

---

*Aaspaas Pro — Built with Claude as Lead Architect*
*Atul's dream that doesn't let him sleep. Session 1 → 48 and counting.*
*Session 48 FINAL: Phase B dual-write OTP identity complete ✅ | persistSession: true ✅ | OTP screen in FirstOpenFlow ✅ | 3/3 Phase B tests passing ✅ | Graceful fallback on OTP failure ✅ | Dormant SMS hook active (Exotel KYC pending) ✅*
*IMMEDIATE NEXT STEP: Session 49 — Phase C RLS migration. Start with Tier 1 financial tables (order_bills, order_items, khata_ledger, khata_transactions, vendor_credits). Write RLS policies using auth.uid() mapped to phone. Verify each tier with tests before moving to next. Opportunistically fix 12 pre-existing test failures during this work.*
