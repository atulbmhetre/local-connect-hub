# AasPaas Pro — Master Development Log

**Last Updated:** Session 48 — 20 June 2026 (Phase B dual-write OTP identity complete. Phase C RLS migration is next.)

## 📋 HOW TO START (for Claude in a new session)

1. Read this file top-to-bottom — latest session block first
2. Check **ATUL'S ACTION ITEMS** table for current priorities
3. Linked Supabase TEST project: `hhdylnhqdzfabsolwxdz` (PROD: `rpxsyeqskvhjmbkxnpmd` — only when Atul explicitly says so)
4. Run tests before and after changes: `npx playwright test --reporter=list`
5. Follow dormant integration pattern for external services (Exotel SMS/calling — swap env vars when KYC complete, no code change)
6. Never commit unless Atul asks
7. English-only for admin UI; EN/HI/MR for user-facing strings

---

## 🏗️ SESSION 48 — PHASE B: DUAL-WRITE OTP IDENTITY (20 June 2026)

### ✅ WHAT WAS DONE
Phase B of the 4-phase OTP auth migration. Real Supabase Phone OTP verification 
added to the first-open/restore flow while keeping localStorage mechanism 
fully working in parallel. Zero behavior change for existing users.

### FILES CHANGED
| File | Change |
|------|--------|
| `src/lib/supabase.ts` | `persistSession: false` → `persistSession: true` |
| `src/lib/userIdentity.ts` | Added `requestPhoneOtp()` and `verifyPhoneOtp()` helpers |
| `src/components/FirstOpenFlow.tsx` | New `otp_pending` step in state machine + OTP UI screen |
| `src/lib/strings.ts` | 6 new `firstopen_otp_*` keys (EN/HI/MR) |
| `tests/phone-auth-phase-b.spec.ts` | 3 new tests — PHASE-B-01, PHASE-B-02, PHASE-B-03 |

### PHASE B — WHAT WAS BUILT
**State machine:** `restore` → `otp_pending` → `notification_permission` → `done`

**Flow:**
- User enters phone in restore screen
- Both account-found AND no-account paths call `requestPhoneOtp(digits)` before 
  proceeding to notification step
- OTP request success → `otp_pending` screen shown (6-digit input)
- User enters OTP → `verifyPhoneOtp()` → real Supabase JWT session established
- Session persists across restarts (persistSession: true)
- OTP request failure → graceful fallback → `goToNotificationStep()` (localStorage 
  path still completes, no lockout)
- OTP skip button → same graceful fallback

**Why persistSession: true is correct:**
Phase C RLS will enforce JWT-based ownership on DB operations. A session that 
doesn't persist across restarts is useless for RLS enforcement. This change is 
safe now because RLS is not yet enforced (Phase C) — localStorage identity still 
drives the app as before.

**Dormant mode still active:**
Exotel KYC not yet complete. `sms-hook` edge function runs in dormant mode — 
writes OTP to `_test_otp_capture` table instead of sending real SMS. 
Pattern identical to AiBridgeSheet's `tel:` fallback. When Exotel KYC completes, 
swap `EXOVERIFY_APP_ID` + `EXOVERIFY_APP_SECRET` env vars — no code change needed.

**Test results:** 3/3 passing (PHASE-B-01, PHASE-B-02, PHASE-B-03)

### NO MIGRATIONS — Phase B is client-side only. TEST project only.
PROD untouched until Exotel KYC complete.

### OPEN ITEMS CARRIED INTO SESSION 49
| # | Item | Priority | Next step |
|---|---|---|---|
| 19-D | **Phase C — RLS migration Tier 1→2→3** | 🔴 High | Start with financial tables: `order_bills`, `order_items`, `khata_ledger`, `khata_transactions`, `vendor_credits`. Each tier verified by tests before next. Opportunistically fix 12 pre-existing test failures while touching same tables. |
| 19-E | Phase D — retire legacy auth path | Medium | After Phase C fully verified |
| 7 | Vendor call button not wired in IncomingOrdersSection | Medium | Wire `AiBridgeSheet` into accepted-order block |
| — | Razorpay vendor subscription ₹99/month | Medium | Pending |
| — | APK rebuild + 2-phone device test with Gajanand | Medium | Pending |
| — | 12 pre-existing test failures | Low | Fix opportunistically during Phase C |

---

## 🔴 ATUL'S ACTION ITEMS (open — update each session)

| # | Item | Priority | Next step |
|---|---|---|---|
| 19-D | **Phase C — RLS migration Tier 1→2→3** | 🔴 High | Start with financial tables: `order_bills`, `order_items`, `khata_ledger`, `khata_transactions`, `vendor_credits`. Each tier verified by tests before next. Opportunistically fix 12 pre-existing test failures while touching same tables. |
| 19-E | Phase D — retire legacy auth path | Medium | After Phase C fully verified |
| 7 | Vendor call button not wired in IncomingOrdersSection | Medium | Wire `AiBridgeSheet` into accepted-order block |
| — | Razorpay vendor subscription ₹99/month | Medium | Pending |
| — | APK rebuild + 2-phone device test with Gajanand | Medium | Pending |
| — | 12 pre-existing test failures | Low | Fix opportunistically during Phase C |

---

## 📜 SESSION HISTORY (from MASTER_LOG.md)

# Aaspaas Pro — Master Log

Project documentation: known issues, tech debt, and key decisions.

## KNOWN_BUGS / TECH DEBT

| Issue | Severity | Notes |
|-------|----------|-------|
| RLS blanket policy "Anyone can update request status" still active | High | Must drop when JWT auth is wired — currently all JWT-based policies are shadowed by this. Also clean up duplicate INSERT and SELECT policies. |
| User push when vendor cancels order | Medium | Needs `user_devices` table (`device_id` + `fcm_token`) and `invokeNotifyUser` before cancel can notify offline users; Realtime + MyOrders UI handles open-app case for now. |

## KEY DECISIONS LOG

| Topic | Decision | Notes |
|-------|----------|-------|
| RLS tightening | Deferred — app uses anon key, JWT policies don't fire yet | Needs proper auth session before RLS can enforce vendor/user boundaries |

## requests table schema

| Column | Type | Notes |
|--------|------|-------|
| delivery_slot | text | Nullable — ASAP/Morning/Afternoon/Evening/Tomorrow |

---

*Aaspaas Pro — Built with Claude as Lead Architect*
*Atul's dream that doesn't let him sleep. Session 1 → 48 and counting.*
*Session 48 FINAL: Phase B dual-write OTP identity complete ✅ | persistSession: true ✅ | OTP screen in FirstOpenFlow ✅ | 3/3 Phase B tests passing ✅ | Graceful fallback on OTP failure ✅ | Dormant SMS hook still active (Exotel KYC pending) ✅*
*IMMEDIATE NEXT STEP: Session 49 — Phase C RLS migration. Start with Tier 1 financial tables (order_bills, order_items, khata_ledger, khata_transactions, vendor_credits). Write RLS policies that use auth.uid() mapped to phone. Verify each tier with tests before moving to next. Opportunistically fix 12 pre-existing test failures during this work.*
