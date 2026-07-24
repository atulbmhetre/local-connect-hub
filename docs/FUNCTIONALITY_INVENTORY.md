# Functionality Inventory

**Method:** Every file under `src/pages/` and `src/components/` was read in full (pages, feature components, `settings/`, `vendor/`, and `ui/` primitives). Behavior below is derived only from what the code renders and calls today—not from comments, docs, or intended design.

**Scope date:** 2026-07-08

---

## Auth & Session

### First-open / phone restore
- **What it does:** On first visit (`localStorage` `aaspaas:first_open_done` absent), shows a fullscreen flow: enter 10-digit phone → RPC `lookup_user_by_phone` → if found, writes `aaspaas:phone` and continues; optional “Register as vendor” navigates to `/vendor`. Then native push permission step. OTP screen exists but `OTP_ENABLED = false` so it is never shown. Completing sets `aaspaas:first_open_done` and calls parent `onComplete`.
- **Files:** `src/components/FirstOpenFlow.tsx`, `src/pages/Index.tsx` (mounts overlay)
- **DB:** RPC `lookup_user_by_phone`; table `vendors` (select by phone for vendor hint)
- **Page structure (Index, mobile ~390px):** Overlay covers entire home; restore step shows title, phone input (max 10), Continue, Skip, vendor button—fits one screen without scroll.
- **Status:** Partially implemented — OTP path is present but unreachable; push step native-only.
- **Suspicious:** Entire OTP UI is dead while flag is false; Phase D console warnings; reads `vendors` only for CTA visibility.

### Phone entry sheet (mid-flow)
- **What it does:** Bottom sheet collects 10-digit Indian mobile before order/save; validates length 10; optional “Welcome back” if `lookup_user_by_phone` finds prior orders (unless `skipRecovery`).
- **Files:** `src/components/PhoneEntrySheet.tsx`, used by `ParchiSheet.tsx`, `RadarVendorCard.tsx`
- **DB:** RPC `lookup_user_by_phone`
- **Page structure:** Compact sheet ~40–50% viewport: title, input or recovery copy, Continue/Cancel, privacy note.
- **Status:** Fully implemented.
- **Suspicious:** Hardcoded English strings; no `data-testid`.

### Session identity (client)
- **What it does:** App uses `localStorage` keys `aaspaas:phone`, `aaspaas:device_id`, `aaspaas:vendor_id`, `aaspaas:role`; `getUserPhone()` / `getDeviceId()` read them for RLS-aligned queries. Vendor session synced via `vendorSessionSync` events for bottom nav.
- **Files:** Consumed across pages; `src/components/BottomNav.tsx`, `src/components/FirstOpenFlow.tsx`, `src/pages/VendorMode.tsx`, `src/lib/userIdentity.ts` (imported from components/pages)
- **DB:** Indirect—all authenticated queries filter by phone/device/vendor id from storage
- **Status:** Fully implemented (client-side session model).
- **Suspicious:** Settings dev menu can overwrite phone and reload; no server session binding visible in UI layer.

### Referral link capture
- **What it does:** Route `/r/:code` stores code in `localStorage`, calls `recordUserReferral` if phone exists, redirects to `/`. Renders nothing.
- **Files:** `src/components/ReferralRedirect.tsx`, `src/App.tsx`
- **DB:** `create_referred_user`, `record_user_referral_reward`, `vendors` lookup (via lib)
- **Status:** Fully implemented (invisible handler).

---

## Home & Discovery Entry

### Home screen (Index)
- **What it does:** Main customer hub: AI/voice search (classifies term → navigates `/radar`), SOS empty search → radar, saved neighbours horizontal list, active-order count link, category grid by service mode, notification bell, first-open overlay.
- **Files:** `src/pages/Index.tsx`, `AppShell`, `SOSButton`, `CategoryPicker`, `NeighbourSheet`, `AiBridgeSheet`, `ParchiSheet`, `FirstOpenFlow`, `NotificationBell`
- **DB:** `saved_vendors`, `vendors`, `requests` (help banner + realtime), `fetchCategories`, `classifySearchTermForRadar`
- **Page structure (top → bottom, ~390px):** Header (title + bell) → optional help banner → search input + mic → large SOS button → “My Neighbourhood” chips (horizontal scroll) → optional active orders link → category sections (3 mode groups, ~4–8 tiles visible before scroll). **~8–12 distinct elements above fold.**
- **Status:** Fully implemented.
- **Suspicious:** Sets `aaspaas:role=user` on mount; `void helpBannerTick` forces re-render; category grid duplicates radar category UI pattern.

### Landing / app download
- **What it does:** Standalone marketing page: value props, Web Share or clipboard copy of app URL, vendor register hint (text only, no link).
- **Files:** `src/pages/Landing.tsx`
- **DB:** None
- **Page structure:** Full-screen dark layout, header + 3 cards + CTA + footer; all visible without scroll.
- **Status:** Partially implemented — no navigation to vendor registration.
- **Suspicious:** Toast `"Link copied!"` not i18n; no `AppShell`/nav.

### Category picker (SOS fallback)
- **What it does:** Full-screen modal grid of categories + “speak it” mic; parent supplies categories; selecting navigates to radar with query.
- **Files:** `src/components/CategoryPicker.tsx`, `src/pages/Index.tsx`
- **DB:** None (parent loads categories)
- **Page structure:** Header, 2-column grid (~6–8 tiles visible), mic button.
- **Status:** Fully implemented.
- **Suspicious:** Hardcoded English; same category-tile pattern as Index/Radar/VendorMode registration.

---

## Radar Search

### Geo vendor search (help / delivery / appointment)
- **What it does:** GPS-based vendor discovery with mode tabs, search term in URL, radius chips (15–500 km + Pan-India), AI category suggestion, local bbox + Pan-India parallel fetch, skeleton loading, results as `RadarVendorCard`, government emergency panels (108/101/104), empty-state radius expand, saved-vendor merge, mode-mismatch hints.
- **Files:** `src/pages/RadarSearch.tsx`, `RadarVendorCard.tsx`, `NetworkErrorBanner`, `NotificationBell`, `TrustWarningBanner`, `GovEmergencyServices` / `EmptyStateFailsafe` (exported from RadarSearch)
- **DB:** `categories`, `vendor_categories`, `vendors`, `vendor_verification`, `vendor_menu_items`, `saved_vendors`, `requests`; edge `invokeSuggestCategory`
- **Page structure (~390px):** Back + live label + headline + bell → mode selector (3 pills) → search input → mini radar graphic + count → radius chips (wrap, ~2 rows) → first result card or skeleton. **~10–14 elements above fold; one vendor card ~350–500px tall.**
- **Status:** Fully implemented.
- **Suspicious:** Comment encoding glitch in emergency panel; `app-settings:` on web; complex dual-fetch race guarded by `fetchSeqRef`.

### Radar vendor card (shared)
- **What it does:** Primary vendor result card: photo, binary trust banner + accent ring (`vendorBinaryTrustTier`), reputation, menu preview, save/unsave neighbour, AI-Bridge call, order/book via `ParchiSheet`, resolution helped/delivered, rate-card sheet, photo lightbox, session caching.
- **Files:** `src/components/RadarVendorCard.tsx`, nested `PhoneEntrySheet`, `ParchiSheet`, `AiBridgeSheet`
- **DB:** `vendor_menu_items`, `requests`, `saved_vendors`, `vendors`, `vendor_reviews`; RPCs `save_saved_vendor`, `unsave_saved_vendor`, `increment_vendor_delivered`, `increment_vendor_helped`
- **Status:** Fully implemented (shared component—single implementation for radar lists). Audited CLOSED (TEST + PROD).
- **Suspicious:** Resolution + `RatingSheet` may double-count stats; `resolutionSessionTick` anti-flicker hack.

### Legacy vendor card (unused)
- **What it does:** Was a simple card with stub “AI-Bridge Call” toast only (also exposed plaintext UPI and pre-binary `vendorTier()` yellow trust).
- **Files:** Deleted — was `src/components/VendorCard.tsx`
- **DB:** None
- **Status:** Removed in `1ec1170` (2026-07-18) during an earlier Radar audit; superseded by `RadarVendorCard`. Inventory line kept only so the Phase 2 tally stays 66 `###` entries.
- **Suspicious:** None (deleted).

---

## Vendor Registration & Vendor Mode

### Vendor onboarding (native)
- **What it does:** Five-step fullscreen permission walkthrough (notifications, location, battery, camera); stores `aaspaas:vendor_onboarded`; returns `null` on web.
- **Files:** `src/components/VendorOnboarding.tsx`, `src/pages/VendorMode.tsx`
- **DB:** None
- **Status:** Fully implemented on native only.

### Vendor registration (new shop)
- **What it does:** Form: vendor type (shop/home/visiting), name, shop name, AI category suggest + manual chips, phone, UPI, UPI QR upload (jsQR), note, referral code, GPS capture; submits `invokeRegisterVendor` edge/RPC; sets vendor id in localStorage.
- **Files:** `src/pages/VendorMode.tsx` (registration branch)
- **DB:** RPC `register_vendor` (via invoke); `categories`; edge `invokeSuggestCategory`, `invokeAttachPendingCategory`, `process-vendor-referral`
- **Page structure:** Long scroll form—type chips, ~8–10 fields visible before scroll on mobile.
- **Status:** Fully implemented.
- **Suspicious:** UPI verify is simulated (timeout then `upi_verified: true`); `console.log` vendorOrderStats.

### Vendor phone lookup (returning vendor)
- **What it does:** “Already registered” path: enter phone → load vendor row → set `aaspaas:vendor_id`.
- **Files:** `src/pages/VendorMode.tsx`
- **DB:** `vendors` select by phone
- **Status:** Fully implemented.

### Go live / offline
- **What it does:** Toggle `is_active` via `patchVendorOwn`; offline blocked if active orders exist (AlertDialog); trial/expired banners; realtime `vendors` subscription updates badge.
- **Files:** `src/pages/VendorMode.tsx`, `IncomingOrdersSection.tsx` (reads active state)
- **DB:** `vendors` patch; `requests` count for block
- **Status:** Fully implemented.

### Vendor verification checklist
- **What it does:** Sheet: UPI verify (simulated), GPS, shop photo (`LiveCamera`), selfie, shop info, `VendorNoteEditor`; submits `submit_vendor_verification` RPC.
- **Files:** `src/pages/VendorMode.tsx`, `LiveCamera.tsx`, `VendorNoteEditor.tsx`, `VerificationBadge.tsx`
- **DB:** RPC `submit_vendor_verification`; storage buckets; `patchVendorOwn`
- **Status:** Partially implemented — UPI verification not real PSP.

### Edit shop details
- **What it does:** Sheet to edit type, name, categories (`vendor_update_categories`), phone, UPI.
- **Files:** `src/pages/VendorMode.tsx`
- **DB:** RPC `vendor_update_categories`; `vendor_categories` load; `patchVendorOwn`
- **Status:** Fully implemented.

### Vendor analytics summary
- **What it does:** Collapsible 2×3 grid of order stats (computed in VendorMode from loaded orders).
- **Files:** `src/components/vendor/VendorAnalytics.tsx`, `src/pages/VendorMode.tsx`
- **DB:** None in component (parent aggregates `requests`)
- **Status:** Fully implemented (display only).

### Banned vendor gate
- **What it does:** If `is_banned`, full-screen message; no dashboard.
- **Files:** `src/pages/VendorMode.tsx`
- **DB:** `vendors.is_banned`
- **Status:** Fully implemented.

---

## Help Mode Orders

### Customer help order (AI-Bridge / neighbour)
- **What it does:** From radar/neighbour/home: `ParchiSheet` with message, optional share location; creates request via `create_customer_request`; trust gates (low/medium); notifies vendor.
- **Files:** `ParchiSheet.tsx`, `RadarVendorCard.tsx`, `NeighbourSheet.tsx`, `Index.tsx`
- **DB:** RPC `create_customer_request`; `vendor_menu_items`; `insert_user_address`; edge `parse-image-order`
- **Status:** Fully implemented for help/delivery/appointment modes via same sheet with mode-specific fields.

### Help live tracking
- **What it does:** Map shows user + vendor markers, distance, ETA, stalled alert; vendor location via realtime `vendors` UPDATE; “Secure Call” opens **mock** modal (no `invokeInitiateCall`).
- **Files:** `src/pages/LiveTracking.tsx`, `TrustWarningBanner`, `VerificationBadge`
- **DB:** `vendors` select + realtime
- **Page structure:** Map ~50% viewport, responder card, call/share/flash buttons below.
- **Status:** Partially implemented — map works; call is cosmetic.
- **Suspicious:** `/tracking` without `:vendorId` useless; torch `@ts-expect-error`; hardcoded English.

### AI-Bridge pre-call sheet
- **What it does:** Briefing sheet before masked call; `invokeInitiateCall` edge (Exotel) with `tel:` fallback; template “brief” (not LLM); auto-closes after 3s.
- **Files:** `AiBridgeSheet.tsx`, used from Radar, Neighbour, IncomingOrders, MyOrders, VendorSettings
- **DB:** Edge `invokeInitiateCall`
- **Status:** Partially implemented — “AI brief” is static template.
- **Suspicious:** Auto-close regardless of call outcome.

### Home help-order banner
- **What it does:** If accepted help-mode order in 48h, banner on home links to My Orders; stale location warning; realtime updates.
- **Files:** `src/pages/Index.tsx`
- **DB:** `requests` filter + realtime; active-order RPC uses phone + device (OTP-off)
- **Status:** Fully implemented. Audited CLOSED (TEST + PROD).

### Neighbour (saved vendor) sheet
- **What it does:** Bottom sheet for saved vendor: mode-specific CTAs (order, book, AI-Bridge), nickname edit/clear, remove neighbour.
- **Files:** `NeighbourSheet.tsx`, `Index.tsx`, `src/lib/savedVendors.ts`
- **DB:** RPCs `unsave_saved_vendor`, `save_saved_vendor`, `update_saved_vendor_nickname`
- **Status:** Fully implemented. Audited CLOSED (TEST + PROD).

---

## Delivery Mode Orders

### Delivery order placement
- **What it does:** `ParchiSheet` shows address field, delivery slot select, menu multi-select, message; submits delivery request.
- **Files:** `ParchiSheet.tsx`, `RadarVendorCard.tsx`
- **DB:** Same as help — `create_customer_request`, `vendor_menu_items`, addresses
- **Status:** Fully implemented.

### Delivery slot / address on vendor side
- **What it does:** Incoming order card shows address block and slot; maps deep link; accept/decline flow.
- **Files:** `IncomingOrdersSection.tsx`
- **DB:** `requests` fields `address_text`, `delivery_slot`, etc.
- **Status:** Fully implemented.

---

## Appointment Mode Orders

### Appointment booking
- **What it does:** `ParchiSheet` datetime picker, optional location, message; creates appointment request.
- **Files:** `ParchiSheet.tsx`
- **DB:** `create_customer_request`
- **Status:** Fully implemented.

### Vendor confirm / decline appointment
- **What it does:** Vendor confirms or declines via RPC; decline reason sheet.
- **Files:** `IncomingOrdersSection.tsx`
- **DB:** RPC `vendor_confirm_appointment`, `vendor_decline_booking`
- **Status:** Fully implemented.
- **Suspicious:** `handleAppointmentAction(..., "declined")` early-returns; separate decline sheet used.

---

## Incoming Orders (Vendor Dashboard)

### Incoming orders list & actions
- **What it does:** Loads 20 active/fulfilled requests, 30s poll + realtime; search filter; per-order: accept, decline, mark seen/sent, fulfil, dismiss, cancel, flag user, maps; embeds billing and payment flows.
- **Files:** `IncomingOrdersSection.tsx`, `src/pages/VendorMode.tsx`
- **DB:** `requests`, `order_bills`, `khata_ledger`, `khata_transactions`, `users`; many vendor RPCs (accept, fulfil, dismiss, cancel, flag, etc.)
- **Page structure (VendorMode, ~390px):** After go-live card (~120px), section header “Incoming” + badge → search → **one order card** (~200–400px). Typically **1 card visible** without scroll.
- **Status:** Fully implemented.
- **Suspicious:** `calledUser` state never used; cancel notify may use wrong `order_id`; dispute notify type may be wrong; duplicate `incoming-decline-btn` testids.

---

## Khata / Billing

### Send bill (vendor)
- **What it does:** Bottom sheet: line items, voice/image parse, cash/UPI/khata payment mode, khata limit warnings, replace existing bill, send via `insert_bill_with_items`.
- **Files:** `BillSheet.tsx`, `IncomingOrdersSection.tsx`
- **DB:** `order_bills`, `khata_ledger`; RPC `insert_bill_with_items`, `vendor_void_unpaid_bills`; edges `parse-voice-bill`, `parse-image-bill`
- **Status:** Fully implemented.
- **Suspicious:** `isReplace` param unused in execute path.

### Edit bill (vendor)
- **What it does:** Edit line items + reason; late-edit confirmations; `vendor_edit_bill` RPC.
- **Files:** `BillEditSheet.tsx`, `IncomingOrdersSection.tsx`, `MyOrders.tsx` (customer view history)
- **DB:** RPC `vendor_edit_bill`; `bill_edit_audit`, `order_items`
- **Status:** Fully implemented.

### Bill edit history
- **What it does:** Read-only audit list for a bill.
- **Files:** `BillEditHistorySheet.tsx`
- **DB:** `bill_edit_audit` (via lib)
- **Status:** Fully implemented.

### Khata ledger (vendor book)
- **What it does:** Lists customers with outstanding balances; detail sheet: transactions, edit display name, call customer, partial payment, mark all paid, refund.
- **Files:** `src/pages/LedgerView.tsx`
- **DB:** `khata_ledger`, `khata_transactions`, `vendors`; RPCs `get_vendor_customer_names`, `vendor_update_customer_name`, `vendor_record_khata_payment`, `vendor_mark_customer_khata_bills_paid`, `vendor_record_khata_refund`; `invokeInitiateCall`, `invokeNotifyUser`
- **Page structure:** Back + title → customer rows (~3–5 visible) → sheets for detail/amount.
- **Status:** Fully implemented.
- **Suspicious:** Android WebView scroll hack; redirects to `/vendor` if no vendor id in storage.

### Add bill to khata / khata from order
- **What it does:** Vendor adds existing bill to khata ledger; khata payment mode on new bills.
- **Files:** `IncomingOrdersSection.tsx`, `BillSheet.tsx`
- **DB:** RPC `add_bill_to_khata`; `khata_ledger`, `khata_transactions`
- **Status:** Fully implemented.

### Customer khata view (My Orders)
- **What it does:** Tabs/section for outstanding khata per vendor; detail sheet with transactions.
- **Files:** `src/pages/MyOrders.tsx`
- **DB:** `khata_ledger`, `khata_transactions`
- **Status:** Fully implemented.
- **Suspicious:** Some hardcoded English in khata detail sheet.

### Khata settings (vendor)
- **What it does:** Toggle khata credit, set amber/red limits; blocked when outstanding balance > 0; server rejects `red ≤ amber` (`khata_limits_invalid`).
- **Files:** `src/components/settings/VendorSettings.tsx`
- **DB:** `vendor_update_own`; reads `khata_ledger`
- **Status:** Fully implemented. Audited CLOSED (TEST + PROD).

### UPI payment confirm / dispute (vendor)
- **What it does:** Vendor confirms or disputes customer UPI payment claim on order.
- **Files:** `IncomingOrdersSection.tsx`
- **DB:** RPC `confirm_upi_payment`, `dispute_upi_payment`
- **Status:** Fully implemented.

---

## Customer Payments

### Customer UPI payment sheet
- **What it does:** Tabs UPI ID / Mobile / QR; deep-link pay; return prompt; 12-digit UTR submit; `claim_customer_payment`; status views.
- **Files:** `PaymentSheet.tsx`, `MyOrders.tsx`
- **DB:** RPC `claim_customer_payment`; `invokeNotifyVendor`
- **Status:** Fully implemented.
- **Suspicious:** Hardcoded English tab labels; strict 12-digit UTR vs looser ParchiSheet payment.

### Inline post-fulfillment payment (Parchi)
- **What it does:** On fulfilled order reopen, payment section in `ParchiSheet` can claim payment.
- **Files:** `ParchiSheet.tsx`
- **DB:** `claim_customer_payment`
- **Status:** Fully implemented.

---

## My Orders (Customer)

### Order list & lifecycle
- **What it does:** Lists customer requests with search; status badges; edit sent/seen orders (text/voice/image); cancel; dismiss; rate; pay; maps for help; delivery/appointment blocks; bill display; bill-edited badge.
- **Files:** `src/pages/MyOrders.tsx`, `RatingSheet`, `PaymentSheet`, `BillEditHistorySheet`, `AiBridgeSheet`
- **DB:** `requests`, `order_bills`, `order_items`, `vendor_reviews`, `user_notifications`; RPCs `dismiss_order`, `cancel_customer_order`, `edit_customer_order`, `update_vendor_review`; realtime `requests`, `vendors` location
- **Page structure (~390px):** Back + title + bell → search → optional khata tabs → **one order card** (~250–400px). **~4–6 elements above fold.**
- **Status:** Fully implemented.
- **Suspicious:** Hardcoded English notification strings in edit save; distance strings English only.

### Order card pattern
- **What it does:** Customer order card UI is implemented **inside `MyOrders.tsx`** (`data-testid="order-card"`).
- **Vendor incoming order card** is a **separate implementation** in `IncomingOrdersSection.tsx` (`incoming-order-card`).
- **Status:** Fully implemented but **duplicated pattern** (not shared component).

---

## Ratings & Reviews

### Post-order rating sheet
- **What it does:** 1–5 stars, optional review (voice on native), submit/skip/report issue; `submit_vendor_review`; may increment delivered/helped; sync rating; notify vendor on low stars.
- **Files:** `RatingSheet.tsx`, `MyOrders.tsx`
- **DB:** `vendor_reviews`; RPCs `submit_vendor_review`, `increment_vendor_*`, `increment_vendor_issues`; `syncVendorRatingFromReviews`
- **Status:** Fully implemented.
- **Suspicious:** Unused `lang` variable; `vendorPhone` in deps unused.

### Vendor reply to reviews
- **What it does:** In Settings → MY SHOP → Reviews: load reviews, reply (`vendor_reply_to_review`), call customer via `AiBridgeSheet`.
- **Files:** `VendorSettings.tsx`, `src/lib/vendorReviewReply.ts`
- **DB:** `vendor_reviews`; RPC `vendor_reply_to_review`
- **Status:** Fully implemented (settings path—not separate page). Audited CLOSED (TEST + PROD).

### Admin delete low reviews
- **What it does:** Admin tab lists low ratings; delete via `admin_delete_review` (`is_admin_session` gate).
- **Files:** `src/pages/Settings.tsx` (admin section), `src/lib/adminLowRatings.ts`
- **DB:** RPC `admin_delete_review`
- **Status:** Fully implemented (admin-only). Audited CLOSED (TEST + PROD).

---

## Referrals

### Vendor refer & earn
- **What it does:** Shows referral code, credit totals, copy/share; credits from `vendor_credits` / referrals tables.
- **Files:** `VendorSettings.tsx` (`VendorSettingsReferEarn`), `src/pages/VendorMode.tsx` (code at registration)
- **DB:** `referrals`, `vendor_credits`, `vendors.referral_code`
- **Status:** Fully implemented.

### Customer referral redirect
- **What it does:** See Auth — `/r/:code` handler.
- **Files:** `ReferralRedirect.tsx`
- **Status:** Fully implemented.

---

## Local Feed

### Feed reader
- **What it does:** Geo-filtered posts via `get_local_feed_posts`; category chips; offer/announcement/recommendation cards; replies; flag; cache in localStorage 5 min; compose FAB.
- **Files:** `src/pages/LocalFeed.tsx`, `FeedReachChips`, `FeedImagePicker`, `NotificationBell`
- **DB:** RPCs `get_local_feed_posts`, `get_feed_preferences`, `get_user_device`, `submit_feed_reply`, `increment_flag_count`, `submit_customer_feed_post`; tables `feed_posts`, `feed_replies`, `feed_flags`, `vendors`, `categories`
- **Page structure (~390px):** Title + bell + FAB → filter chips → **1–2 post cards** (~200px each).
- **Status:** Fully implemented.
- **Suspicious:** Client-side fallback if RPC fails; category filter only for offers.

### Vendor post offer
- **What it does:** Vendor posts offer with image, dates, reach radius via `vendor_post_offer`; hide via `vendor_hide_feed_post`.
- **Files:** `VendorSettings.tsx` (`VendorSettingsOffers`)
- **DB:** RPC `vendor_post_offer`, `vendor_hide_feed_post`; `feed_posts`
- **Status:** Fully implemented.

### Feed discovery radius (reader)
- **What it does:** Settings chips set discovery radius via `set_feed_discovery_radius` / `get_feed_preferences`.
- **Files:** `src/pages/Settings.tsx`, `FeedReachChips.tsx`
- **DB:** RPC `get_feed_preferences`, `set_feed_discovery_radius`
- **Status:** Fully implemented.

---

## Notifications

### In-app notification bell
- **What it does:** Bell with unread badge; sheet lists `user_notifications`; realtime subscription; mark read, dismiss, clear; tap navigates via `notificationNavigation`; optional extra vendor pending-order count.
- **Files:** `NotificationBell.tsx`, mounted on Index, Radar, Feed, Orders, Settings, VendorMode
- **DB:** RPCs `get_user_notifications`, `mark_user_notifications_read`, `mark_user_notification_read`, `delete_user_notification`, `clear_user_notifications`; realtime on `user_notifications`
- **Status:** Fully implemented.
- **Suspicious:** No `data-testid` on bell (tests expect them).

### Push navigation bridge
- **What it does:** Registers router `navigate` for native push deep links; consumes pending route on mount.
- **Files:** `PushNavigationBridge.tsx`, `App.tsx`
- **DB:** None
- **Status:** Fully implemented (renders null).

### Feed push toggle
- **What it does:** Native toggle for feed notifications in Settings.
- **Files:** `Settings.tsx`, hook `useFeedNotificationsEnabled`
- **DB:** Preferences via RPC/storage (hook layer)
- **Status:** Fully implemented (native).

---

## Settings

### My Account (customer)
- **What it does:** Collapsible: phone display, account standing badge, delivery addresses CRUD, theme, language, voice language, large text.
- **Files:** `src/pages/Settings.tsx`, `SettingsSection.tsx`, hooks `useUserAddresses`, `useTheme`
- **DB:** RPC `update_user_address`, `delete_user_address`, `lookup_user_by_phone`; table `user_addresses`
- **Page structure (~390px):** Header + bell → Register business CTA (if not vendor) → MY ACCOUNT header → ~3–5 rows visible (standing, theme, language).
- **Status:** Fully implemented.

### MY SHOP (vendor settings)
- **What it does:** Subscription card (Razorpay script, trial/active/grace/expired), shop info, service radius chips, vendor note, menu CRUD (voice/image parse), offers, order alerts (native), refer & earn, cancel reasons, ledger cycle, khata limits, reviews.
- **Files:** `VendorSettings.tsx`, `ServiceRadiusChips`, `VendorNoteEditor`, `FeedImagePicker`, `FeedReachChips`, `AiBridgeSheet`
- **DB:** Many `vendor_*` RPCs; `feed_posts`, `vendor_menu_items`, `vendor_reviews`, `khata_ledger`; edges parse-voice/image-bill for menu
- **Status:** Partially implemented — Razorpay success patches subscription client-side without server verify; subscription cancel opens WhatsApp only.
- **Suspicious:** Unused `Bell` import; `shopName` prop unused in offers sub-component.

### Device permissions
- **What it does:** Native Capacitor permission status + request for notifications, location, camera, mic, battery.
- **Files:** `Settings.tsx`
- **DB:** None
- **Status:** Fully implemented on native; minimal on web.

### Account deletion
- **What it does:** Schedule/cancel deletion via edge invokes; dual-role messaging; 30-day vendor shop policy copy.
- **Files:** `Settings.tsx`
- **DB:** Edge `invokeDeleteAccount`, `invokeCancelDeletion`; RPC `delete_user_devices_for_phone`
- **Status:** Fully implemented.

### Clear my data
- **What it does:** Clears localStorage/session keys and reloads.
- **Files:** `Settings.tsx`
- **DB:** None
- **Status:** Fully implemented.

### Dev menu (hidden)
- **What it does:** Easter egg on settings title tap; set phone in localStorage and reload.
- **Files:** `Settings.tsx`
- **Status:** Present — reachable only via hidden gesture.

---

## Admin Panel

### Admin access gate
- **What it does:** If user phone in hardcoded admin allowlist, shows Settings | Admin tabs.
- **Files:** `src/pages/Settings.tsx`
- **DB:** None (client allowlist)
- **Status:** Fully implemented.
- **Suspicious:** Security relies on phone string match in client bundle.

### Admin dashboard & moderation
- **What it does:** Stats grid; vendor search verify/ban; flagged users warn/ban; pending categories approve/reject; feed recommendations review; low ratings delete; subscription waive-off; app config whitelist editor; system health card.
- **Files:** `Settings.tsx`, `AdminSystemHealthCard.tsx`
- **DB:** RPCs `get_admin_dashboard_stats`, `admin_*` family, `get_recommendations_for_admin`; tables `vendors`, `users`, `app_config`, `feed_posts`, `categories`, `vendor_reviews`, `admin_alerts`
- **Page structure:** Tab bar → dense admin sections; each moderation area is collapsible/list; **~6–10 admin widgets**, mostly below fold.
- **Status:** Fully implemented.
- **Suspicious:** Large surface area in single file (~4000 lines).

### System health monitoring
- **What it does:** Polls `admin_alerts` every 60s for four edge functions; green/red dots.
- **Files:** `AdminSystemHealthCard.tsx`
- **DB:** `admin_alerts`
- **Status:** Fully implemented (read-only).

---

## Navigation & Shell

### App shell & bottom navigation
- **What it does:** Max-width layout + fixed bottom nav: Home, Feed, Orders, Settings; fifth Vendor tab when `aaspaas:vendor_id` set with online dot.
- **Files:** `AppShell.tsx`, `BottomNav.tsx`
- **DB:** None
- **Status:** Fully implemented.
- **Suspicious:** `AppShell` `theme` prop deprecated/ignored.

### 404 & privacy
- **What it does:** `NotFound` catch-all with link home; `PrivacyPolicy` static 9 sections.
- **Files:** `NotFound.tsx`, `PrivacyPolicy.tsx`
- **DB:** None
- **Status:** Fully implemented (minimal).
- **Suspicious:** NotFound uses `<a href>` full reload; Privacy not linked from Settings UI.

---

## Network & Trust UI

### Network error banner
- **What it does:** Inline retrying/failed banner with optional retry callback.
- **Files:** `NetworkErrorBanner.tsx` — used on Radar, Vendor, Orders, Ledger, Settings
- **Status:** Fully implemented (shared).

### Trust warning banner
- **What it does:** Binary Verified/Unverified warning for radar, AiBridge, and Neighbour→Parchi (`vendorBinaryTrustTier`); tracking keeps its own path. Shared incomplete-verification copy; fail-open messaging when trust fetch cannot confirm.
- **Files:** `TrustWarningBanner.tsx`, `vendorBinaryTrust.ts`
- **Status:** Fully implemented (shared). Audited CLOSED (TEST + PROD).

### Verification badge
- **What it does:** Customer-facing TrustBadge — `is_manual_verified=false` → Unverified only; `true` → Verified · tier (from `trustLevel.ts`). RAD-09: never shown beside legacy `vendorTier` / `getVerificationCopy` G/Y/R labels on Radar, VendorMode, AiBridge, or LiveTracking.
- **Files:** `TrustBadge.tsx`, `VerificationBadge.tsx` (legacy helpers retained where still needed for tracking privacy banner prop), `trustLevel.ts`
- **Status:** Fully implemented (shared). Audited CLOSED (TEST + PROD).

### SOS button
- **What it does:** Pulsing home emergency button → parent handler (radar/category).
- **Files:** `SOSButton.tsx`, `Index.tsx`
- **Status:** Fully implemented.
- **Suspicious:** English `aria-label` while text is i18n.

---

## UI Primitives (`src/components/ui/`)

- **What they do:** shadcn/Radix wrappers (button, sheet, dialog, select, switch, badge, input, textarea, collapsible, radio-group, alert-dialog, sonner, toaster, tooltip, label, skeleton, etc.).
- **Status:** Infrastructure—not user-facing features alone.
- **Unused in `src/` (zero imports from pages/components/hooks):** `accordion`, `aspect-ratio`, `avatar`, `breadcrumb`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `command`, `context-menu`, `drawer`, `dropdown-menu`, `hover-card`, `input-otp`, `menubar`, `navigation-menu`, `pagination`, `popover`, `progress`, `resizable`, `scroll-area`, `sidebar`, `slider`, `table`, `tabs`, `toggle-group` (and `toggle` only via unused toggle-group).

---

## Possible dead code / unused components

| Item | Evidence |
|------|----------|
| `VendorCard.tsx` | Exported; **no imports** anywhere in `src/` |
| `NavLink.tsx` | Custom wrapper; **never imported** (`BottomNav` uses `react-router-dom` directly) |
| `FirstOpenFlow` OTP step | UI exists; `OTP_ENABLED = false` |
| `ParchiSheet` prop `onOrderCancelled` | Declared; never read |
| `IncomingOrdersSection` `calledUser` state | Set never used |
| `VendorSettingsOffers` `shopName` prop | Passed; unused |
| `CategoryPicker` | Used only from Index SOS path |
| 27 `ui/*` primitives | Listed above—scaffold only |

---

## Repeated / duplicated UI patterns across files

| Pattern | Implementations | Shared? |
|---------|-----------------|--------|
| **Order card** (status, message, actions) | `MyOrders.tsx` (`order-card`) vs `IncomingOrdersSection.tsx` (`incoming-order-card`) | **Separate** — large duplicated logic |
| **Vendor result card** | `RadarVendorCard.tsx` (active) vs `VendorCard.tsx` (dead stub) | Was duplicate; legacy file remains |
| **Category tile grid** | `Index.tsx`, `RadarSearch.tsx` (unknown term), `CategoryPicker.tsx`, `VendorMode.tsx` registration chips | **Separate** each time |
| **Phone capture** | `FirstOpenFlow.tsx`, `PhoneEntrySheet.tsx`, `VendorMode.tsx` registration field | **Separate** |
| **Bill / line-item editor** | `BillSheet.tsx`, `BillEditSheet.tsx`, menu editor in `VendorSettings.tsx` (similar rows + voice/image) | **Separate** components, similar layout |
| **Payment / UTR flow** | `PaymentSheet.tsx` vs inline block in `ParchiSheet.tsx` | **Partial overlap** |
| **Review + reply** | `RatingSheet.tsx` (customer) vs `VendorSettings` reviews section (vendor reply) | **Separate** |
| **Feed post card** | Inline `OfferCard` / `AnnouncementCard` / `RecommendationCard` in `LocalFeed.tsx` vs offer management in `VendorSettings` | **Separate** |
| **Settings collapsible rows** | `SettingsSection.tsx` primitives used widely; `VendorMode` also builds custom sheets/collapsibles | **Partially shared** |
| **Emergency / gov helpline panel** | `GovEmergencyServices` inside `RadarSearch.tsx` only | Local to radar |
| **Skeleton loading cards** | `RadarVendorCardSkeleton` in `RadarSearch.tsx` vs skeleton posts in `LocalFeed.tsx` | **Separate** |
| **Trust + verification header** | Repeated assembly in `RadarVendorCard`, `AiBridgeSheet`, `LiveTracking`, `VendorMode` header | Shared badge/banner components but **repeated composition** |

---

## Inventory statistics

| Metric | Count |
|--------|------|
| **Files read** | **99** (11 page `.tsx`, 2 page tests, 82 component `.tsx`, 4 component tests) |
| **Functionality entries** | **52** distinct entries in this document |
| **Routes** | 12 route patterns in `App.tsx` (+ referral redirect) |

---

*End of inventory. No source files were modified.*
