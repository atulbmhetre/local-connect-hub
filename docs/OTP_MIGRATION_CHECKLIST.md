# OTP Migration Checklist

**Purpose:** Single execution list for the day real verified sessions (OTP / Supabase Auth) replace the standing OTP-off model (`localStorage` phone + device; caller-supplied `p_user_phone` / `p_vendor_phone` / `p_device_id` as the credential).

**How to use:** Walk top-to-bottom. For each item: change server identity gate → update client call sites to stop sending phone/device *as auth* → add a spoof-negative test → check off. Do **not** re-investigate the surface area; this doc is the inventory.

**Source:** Live TEST function catalog (`pg_proc` / schema dump 2026-07-25) filtered to args matching `p_user_phone|p_vendor_phone|p_device_id|p_customer_phone|p_phone`, plus shared helpers, plus storage policies (shop-photos audit 2026-07-25). Admin RPCs that already gate on `is_admin_session()` are out of scope (see § Out of scope).

**Standing identity helpers today (OTP-off):**

| Helper | What it trusts today |
|---|---|
| `_customer_identity_ok(device, phone)` | Non-null **either** device **or** phone string (no session) |
| `_assert_vendor_identity(vendor_id, phone)` | Row exists with matching `vendors.id` + `vendors.phone` (spoofable pair) |
| `_assert_vendor_not_banned` / `_assert_vendor_photos_ready` | Same vendor id+phone pair |
| `_assert_user_device_binding(phone, device)` | Row in `user_devices` for that phone+device (both caller-supplied) |
| `_customer_owns_request` / `_vendor_owns_request` | Request row matches caller-supplied phone/device or vendor id+phone |

**Canonical post-OTP fix pattern:**

- **Customer:** Resolve identity from `auth.uid()` → `users` / JWT phone (`auth_user_phone()` once sessions mint). Treat `p_user_phone` / `p_device_id` as **optional hints only**, or drop them. Optionally still require `user_devices` binding for the **session** phone, not a free-form phone param.
- **Vendor:** Resolve `vendors` via `user_id = auth.uid()` (or session phone = `vendors.phone`). Drop `p_vendor_phone` as a credential; `p_vendor_id` must match the session vendor.
- **Storage:** Prefer signed upload URLs or path policies keyed to `auth.uid()` / vendor id from session — never bucket-wide `TO anon` INSERT.

---

## 0. Fix helpers first (unblocks / centralizes most RPC work)

| Done | Name | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `_customer_identity_ok` | Any non-null phone **or** device | Require `auth.uid()`; map to phone; device optional secondary check against `user_devices` for that user |
| ☐ | `_assert_vendor_identity` | Caller `p_vendor_id` + `p_vendor_phone` match `vendors` | Assert `vendors.user_id = auth.uid()` (or session phone); ignore/drop caller phone |
| ☐ | `_assert_user_device_binding` | Caller phone + device exist in `user_devices` | Bind using session phone + device; reject if phone ≠ session |
| ☐ | `_customer_owns_request` | Caller phone/device on `requests` | Own via session phone/device linked to `auth.uid()` |
| ☐ | `_vendor_owns_request` | Caller vendor id+phone on request | Own via session vendor id only |
| ☐ | `_assert_vendor_not_banned` / `_assert_vendor_photos_ready` | Vendor id+phone pair | Session vendor only |

---

## 1. Money-adjacent (khata / bills / UPI / paid fulfilment) — do first

### 1A. Khata mutations

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `add_bill_to_khata` | `p_vendor_id` + `p_vendor_phone` | Session vendor; drop phone credential |
| ☐ | `vendor_record_khata_payment` | Vendor id+phone; customer phone as ledger key | Session vendor; customer phone remains **data**, not auth |
| ☐ | `vendor_record_khata_refund` | Vendor id+phone | Session vendor |
| ☐ | `vendor_mark_customer_khata_bills_paid` | Vendor id+phone | Session vendor |
| ☐ | `vendor_edit_bill` | Vendor id+phone (khata credit side-effects) | Session vendor |
| ☐ | `insert_bill_with_items` | `p_vendor_id` (+ customer phone as data); **no vendor phone param** — ownership must be proven another way | Require session vendor owns `p_order_id`; never trust bare `p_vendor_id` |

### 1B. Bills / payment status

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `vendor_mark_bill_paid` | Vendor id+phone | Session vendor |
| ☐ | `vendor_void_unpaid_bills` | Vendor id+phone | Session vendor |
| ☐ | `confirm_upi_payment` | `p_vendor_phone` (+ request) | Session vendor owns request |
| ☐ | `dispute_upi_payment` | `p_vendor_phone` | Session vendor |
| ☐ | `claim_customer_payment` | Caller `p_user_phone` / `p_device_id` on request | Session customer owns request |

### 1C. Order lifecycle that moves money / fulfilment

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `create_customer_request` | `_customer_identity_ok` + writes caller phone/device onto request | Session customer; stamp phone from session |
| ☐ | `cancel_customer_order` | Phone and/or device match on request | Session customer |
| ☐ | `edit_customer_order` | Phone/device match | Session customer |
| ☐ | `dismiss_order` | Phone/device match | Session customer |
| ☐ | `vendor_accept_order` | Vendor id+phone | Session vendor |
| ☐ | `vendor_fulfill_order` | Vendor id+phone | Session vendor |
| ☐ | `vendor_cancel_order` | Vendor id+phone | Session vendor |
| ☐ | `vendor_confirm_appointment` | Vendor id+phone | Session vendor |
| ☐ | `vendor_decline_booking` | Vendor id+phone | Session vendor |
| ☐ | `vendor_dismiss_requests` | Vendor id+phone | Session vendor |
| ☐ | `vendor_mark_sent_seen` | Vendor id+phone | Session vendor |
| ☐ | `vendor_clear_order_edited` | `_vendor_owns_request` | Session vendor |
| ☐ | `vendor_expire` / related expiry helpers if any still take vendor phone | (verify at cutover) | Session / service_role only |

### 1D. Money-adjacent reads (spoof → leak ledgers / bills)

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `get_my_order_bills` | Phone + device | Session customer |
| ☐ | `get_my_khata_ledger` | `p_user_phone` | Session customer |
| ☐ | `get_my_khata_transactions` | `p_user_phone` | Session customer |
| ☐ | `get_my_bill_edit_audit` | Phone + device | Session customer |
| ☐ | `get_vendor_order_bills` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_khata_ledger` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_khata_transactions` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_khata_request_ids` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_khata_dismiss_txs` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_khata_linked_request` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_khata_has_outstanding` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_bill_line_items` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_edited_bill_ids` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_bill_edit_audit` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_credits` | Vendor id+phone | Session vendor |

---

## 2. Identity / account / session binding — do second

### HIGH PRIORITY — Client identity writes vs OTP (not a config flip)

> **Turning `OTP_ENABLED` on affects only `FirstOpenFlow`'s restore path today.**  
> Every other identity-write location in the app remains completely unverified regardless of that flag. Real development work (not configuration) is required across `PhoneEntrySheet` and `VendorMode` before OTP is meaningfully “on” anywhere that matters. Repo-wide, `requestPhoneOtp` / `verifyPhoneOtp` are only imported by FirstOpen; PhoneEntrySheet and VendorMode never call them.

#### Class A — No OTP wiring at all (more severe than FirstOpen ordering)

Highest-traffic and vendor paths write `saveUserPhone` / `aaspaas:vendor_id` with **zero** OTP UI or helpers. Flipping FirstOpen’s flag leaves these untouched.

| Done | Surface | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | **`PhoneEntrySheet`** (`src/components/PhoneEntrySheet.tsx`) — highest-traffic customer identity write | `completePhoneFlow` → `saveUserPhone` immediately (also on lookup error / “Welcome back” continue). **No** `OTP_ENABLED`, **no** `requestPhoneOtp` / `verifyPhoneOtp`, **no** verify UI. Prod call sites both use `skipRecovery`: **ParchiSheet** (first order) and **RadarVendorCard** (first save-vendor); each then runs `migrateUserPhone` after the sheet already saved the phone. | Build real verification UI from scratch on this sheet (request → verify → only then `saveUserPhone` / `onConfirmed`). Gate parent `migrateUserPhone` / order / save on verified session. Do not treat FirstOpen’s flag as covering this path. |
| ☐ | **`VendorMode` registration** (`handleWizardRegistered` after `VendorRegistrationWizard`) | `saveUserPhone(vendorPhone)` + `localStorage` `aaspaas:vendor_id` on success; no OTP | Require verified session (or post-registration OTP) before writing phone / vendor_id; align with session-vendor model |
| ☐ | **`VendorMode` “Find my account” login** (`lookupVendorByPhone` → `get_vendor_by_phone_login`) | Knowing the phone → `saveUserPhone` + set `vendor_id`; no OTP | OTP (or equivalent) before session restore; stop treating phone string alone as credential |
| ☐ | **`VendorMode` legacy phone backfill** (stored `vendor_id`, missing phone → public `vendors` read) | `saveUserPhone(ownPhone)` from discoverable row; no OTP | Do not backfill identity from a public read; require session / verified login |

#### Class B — OTP wired, but identity written before / regardless of OTP outcome

| Done | Surface | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | **`FirstOpenFlow` restore path** (`src/components/FirstOpenFlow.tsx`) | On `hasAccount`, writes local identity **before** any OTP step: `saveUserPhone` → `migrateUserPhone` → `restoreVendorSession`, then (if `OTP_ENABLED`) may move to `otp_pending`. Flow still completes on OTP **success, request failure, or Skip**. Only place the flag does anything — and it still does not close impersonation. | **Reorder:** request + verify OTP **first**; only on successful `verifyPhoneOtp` run identity writes. Do not write identity on OTP fail or Skip. Hard-gate skip/fallback for real cutover. |

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `ensure_user_device_link` | Caller supplies phone + device; links them | Session phone only; device attaches to `auth.uid()` |
| ☐ | `migrate_device_requests_phone` | Caller device + target phone | Session must own device; phone = session phone |
| ☐ | `migrate_saved_vendors_phone` | Same | Same |
| ☐ | `upsert_user_device` | Caller phone + device | Session phone |
| ☐ | `update_user_device_location` | Caller phone + device | Session phone |
| ☐ | `get_user_device` | Caller phone + device | Session phone |
| ☐ | `set_user_device_feed_notifications` | Caller phone + device | Session phone |
| ☐ | `get_user_device_feed_notifications` | Caller phone + device | Session phone |
| ☐ | `upsert_vendor_device` | Vendor id+phone + device | Session vendor |
| ☐ | `clear_my_data` | `_customer_identity_ok` | Session customer (destructive) |
| ☐ | `delete_user_devices_for_phone` | Caller `p_user_phone` | Session phone only / admin session |
| ☐ | `lookup_user_by_phone` | Any caller can probe by phone | Authenticated self-lookup or admin-only |
| ☐ | `get_vendor_by_phone_login` | Phone → vendor row (restore/login) | After OTP: session establishes vendor; this becomes internal or rate-limited bootstrap only |
| ☐ | `get_vendor_restore_status` | `p_phone` | Session phone / session vendor |
| ☐ | `get_vendor_deletion_status` | `p_phone` | Session phone / session vendor |
| ☐ | `get_vendor_own` | Vendor id+phone | Session vendor |
| ☐ | `vendor_update_own` | Vendor id+phone | Session vendor |
| ☐ | `vendor_update_profile_and_categories` | Vendor id+phone | Session vendor |
| ☐ | `vendor_update_categories` | Vendor id+phone | Session vendor |
| ☐ | `vendor_update_category_profile` | Vendor id+phone | Session vendor |
| ☐ | `vendor_sync_category_modes` (both overloads) | Vendor id+phone | Session vendor |
| ☐ | `vendor_update_availability_modes` | Vendor id+phone | Session vendor |
| ☐ | `vendor_upsert_category_cancel_reasons` | Vendor id+phone | Session vendor |
| ☐ | `attach_pending_category` | Vendor id+phone | Session vendor |
| ☐ | `vendor_promote_green_pending` | Vendor id+phone | Session vendor |
| ☐ | `vendor_promote_category_green_pending` | Vendor id+phone | Session vendor |
| ☐ | `vendor_submit_category_shop_photo` | Vendor id+phone (URL already uploaded) | Session vendor; prefer signed upload first |
| ☐ | `vendor_clear_category_photo_verifications` | Vendor id+phone | Session vendor |
| ☐ | `submit_vendor_verification` | Vendor id+phone | Session vendor |
| ☐ | `vendor_verify_upi` | Vendor id+phone | Session vendor |
| ☐ | `apply_user_referral` | `p_phone` + `p_device_id` | Session phone + device |
| ☐ | `create_referred_user` | Phone + device + code | Session / controlled signup path |
| ☐ | `record_user_referral_reward` | `p_user_phone` | Prefer session / service_role after verified event |
| ☐ | `log_firstopen_restore` | Outcome + device | Session device / telemetry only |

---

## 3. Lower-stakes reads & social / ops — do third

### 3A. Customer reads & neighbour / home

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `get_my_orders` | Phone + device | Session customer |
| ☐ | `get_my_active_order_count` | Phone + device | Session customer |
| ☐ | `get_my_active_request_vendor_ids` | Phone + device | Session customer |
| ☐ | `get_my_fulfilled_request_ids` | Phone + device | Session customer |
| ☐ | `get_my_help_banner_orders` | `p_user_phone` only | Session customer |
| ☐ | `get_my_addresses` | Phone + device | Session customer |
| ☐ | `insert_user_address` | Phone + device | Session customer |
| ☐ | `update_user_address` | `p_user_phone` | Session customer |
| ☐ | `delete_user_address` | `p_user_phone` | Session customer |
| ☐ | `get_saved_vendors` | Phone and/or device | Session customer |
| ☐ | `get_saved_vendors_count` | Phone and/or device | Session customer |
| ☐ | `save_saved_vendor` | Phone and/or device | Session customer |
| ☐ | `unsave_saved_vendor` | Phone and/or device | Session customer |
| ☐ | `update_saved_vendor_nickname` | Phone and/or device | Session customer |
| ☐ | `get_saved_vendor_removal_notices` | `p_user_phone` | Session customer |
| ☐ | `mark_saved_vendor_removal_notices_shown` | `p_user_phone` | Session customer |
| ☐ | `get_vendors_visible_to_customer` | Phone + device (filter) | Session customer |
| ☐ | `should_notify_vendor_order_edit` | Phone + device | Session customer |
| ☐ | `get_feed_preferences` | `p_user_phone` | Session customer |
| ☐ | `set_feed_discovery_radius` | `p_user_phone` | Session customer |
| ☐ | `get_my_feed_flags` | `p_user_phone` | Session customer |
| ☐ | `resolve_user_lang` / `notification_i18n_format` | `p_user_phone` as copy key | Prefer session phone; keep as data arg only if service_role |

### 3B. Notifications inbox

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `get_user_notifications` | Phone + device binding | Session customer |
| ☐ | `get_user_unread_notification_count` | Phone + device | Session customer |
| ☐ | `mark_user_notification_read` | Phone + device | Session customer |
| ☐ | `mark_user_notifications_read` | Phone + device | Session customer |
| ☐ | `delete_user_notification` | Phone + device | Session customer |
| ☐ | `clear_user_notifications` | Phone + device | Session customer |

### 3C. Vendor ops reads / non-money mutations

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `get_vendor_incoming_orders` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_incoming_orders_count` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_accepted_orders` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_blocking_active_orders` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_order_stats_rows` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_customer_trust` | Vendor id+phone | Session vendor |
| ☐ | `get_vendor_customer_names` | `p_vendor_phone` only | Session vendor |
| ☐ | `vendor_update_customer_name` | Vendor id+phone | Session vendor |
| ☐ | `vendor_submit_user_flag` | Vendor id+phone | Session vendor |
| ☐ | `vendor_reply_to_review` | Vendor id+phone | Session vendor |
| ☐ | `vendor_insert_menu_items` | Vendor id+phone | Session vendor |
| ☐ | `vendor_update_menu_item` | Vendor id+phone | Session vendor |
| ☐ | `vendor_delete_menu_item` | Vendor id+phone | Session vendor |
| ☐ | `vendor_toggle_menu_item_availability` | Vendor id+phone | Session vendor |
| ☐ | `vendor_post_offer` | Vendor id+phone | Session vendor |
| ☐ | `vendor_hide_feed_post` | Vendor id+phone | Session vendor |

### 3D. Reviews / feed (customer-authored)

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `submit_vendor_review` | Phone + device + order ownership checks | Session customer |
| ☐ | `update_vendor_review` | `p_user_phone` | Session customer |
| ☐ | `submit_customer_feed_post` (both overloads) | `p_user_phone` | Session customer |
| ☐ | `submit_feed_reply` | `p_user_phone` | Session customer |
| ☐ | `increment_flag_count` | `p_user_phone` | Session customer |

### 3E. Telemetry (low risk but still spoofable)

| Done | RPC | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `log_radar_search` | `p_device_id` | Session device / anonymous aggregate OK |

---

## 4. Storage buckets (not RPCs — same OTP-off class)

**Context (2026-07-25):** Legacy `Allow public upload` / `Allow public view` on PROD `shop-photos` removed; mime jpeg/png/webp + 5MB applied. **Remaining gap:** intentional `Anon upload …` policies still allow any holder of the publishable anon key to INSERT without a verified session.

| Done | Surface | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `shop-photos` — `Anon upload shop photos` / `Anon update shop photos` | `TO anon, authenticated`, `bucket_id` only (no path / uid) | Signed upload URL minted after session vendor check, **or** `WITH CHECK` path `auth.uid()::text || '/%'` / vendor-id prefix from session |
| ☐ | `vendor-selfies` — Anon upload/update | Same bucket-wide anon pattern | Same as shop-photos |
| ☐ | `menu-photos` — Anon upload/update/delete | Same | Same |
| ☐ | `vendor-docs` — Anon upload/update `upi-qr/%` | Path-scoped but still anon | Session vendor + path under that vendor |
| ☐ | `feed-images` — Anon upload `announcements/%` \| `offers/%` | Path-scoped anon | Session user/vendor; path under uid |
| ☐ | Public read policies on all of the above | Public buckets (OK for CDN-style reads if objects are non-sensitive) | Keep public read only if URLs are unguessable **and** uploads are session-gated; otherwise private + signed GET |

**App call sites that assume direct anon `storage.from(...).upload` today (must switch with §4):**  
`VendorMyBusiness` / `BusinessSetupSheet` / `VendorRegistrationWizard` (shop + selfie), `menuPhotoUpload.ts`, `imageUpload.ts` (feed), UPI QR uploads in registration / `VendorMode`.

---

## 5. Client identity sources (must change with §0–§3)

| Done | Client surface | Trusts today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `getUserPhone()` / `aaspaas:phone` localStorage | Client-chosen phone string | Session JWT / `auth.getUser()`; localStorage becomes cache only |
| ☐ | `getDeviceId()` / `aaspaas:device_id` | Client-generated device id | Keep for multi-device; never sole auth |
| ☐ | `aaspaas:vendor_id` + vendor phone in VendorMode | Client-chosen vendor pair passed into every RPC | Session → vendor row; stop sending `p_vendor_phone` as secret |
| ☐ | Playwright / Vitest helpers that mint Auth sessions | Masked OTP-off bugs historically | Keep real-session tests; add explicit anon-no-session negative suite for every migrated RPC |

---

## 6. Realtime delivery under OTP-off (added 2026-07-25)

| Done | Surface | Trusts / blocks today | Post-OTP fix |
|:---:|---|---|---|
| ☐ | `postgres_changes` on `public.requests` (Home help banner, IncomingOrders, MyOrders) | Table is in `supabase_realtime` + `REPLICA IDENTITY FULL`, but SELECT RLS is `user_phone = auth_user_phone()` / vendor phone = `auth_user_phone()`. OTP-off clients have NULL session phone → **Realtime events never delivered**; UI relies on 30–60s polls. Confirmed live: DB status write does not update UI within 8s under OTP-off on TEST and PROD; authenticated / service-role subscribers do receive events. | Same as owner-table reads: session-backed `auth_user_phone()`, or Realtime policies that match the SECURITY DEFINER read model — do not weaken RLS piecemeal |
| ☐ | `postgres_changes` on `user_notifications` (NotificationBell) | Same class (already documented in prelaunch audit); poll is source of truth | Session phone RLS or dedicated Realtime-safe policy |
| ☐ | App channel subscribe-before-auth-hydrate race | Even with a session in storage, Index may subscribe Realtime before JWT attaches | Ensure channels (re)subscribe after `onAuthStateChange` / `getSession()` resolves |

---

## Out of scope (already session-gated or not OTP-off credentials)

- **Admin RPCs** gated by `is_admin_session()` — `p_admin_phone` is audit/label only (reconfirmed in prelaunch admin pass). Do not treat as OTP-off identity.
- **Service-role / cron / edge** callers that use the service key intentionally (expire jobs, notify-*, etc.).
- **Helpers** that only format copy (`notification_i18n_format`) once phone is already authorized upstream — still listed in §3A so call sites stop passing arbitrary phones.

---

## Cutover day checklist (mechanical)

1. ☐ Land Auth OTP so real users have `auth.uid()` + phone claim.  
2. ☐ Ship §0 helper changes (feature-flag or hard cut).  
3. ☐ Migrate §1 money RPCs + client bill/khata/order call sites.  
4. ☐ Migrate §2 identity/account RPCs + **client identity OTP work** (PhoneEntrySheet + VendorMode Class A from scratch; FirstOpen Class B reorder) — not an `OTP_ENABLED` flip.  
5. ☐ Migrate §3 reads/social.  
6. ☐ Migrate §4 storage to signed or path-scoped session uploads; remove bucket-wide `TO anon` INSERT/UPDATE.  
7. ☐ Strip phone/device **credentials** from client RPC payloads (keep only where still needed as non-auth data).  
8. ☐ Run spoof matrix: anon + victim phone/device/vendor_phone → expect `identity_required` / `not_found_or_unauthorized` on every §1–§3 RPC.  
9. ☐ Confirm TEST and PROD live catalogs match (no leftover `p_vendor_phone`-only gates).  
10. ☐ Update `docs/PRELAUNCH_AUDIT.md` / inventory: OTP-off sweep closed.

---

## Counts (approx.)

| Band | Entries |
|---|---|
| §0 Helpers | 6 |
| §1 Money-adjacent | ~40 |
| §2 Identity/account | ~40 (incl. Class A PhoneEntrySheet/VendorMode + Class B FirstOpen) |
| §3 Lower-stakes | ~55 |
| §4 Storage + app upload sites | ~10 |
| §5 Client identity | 4 |
| **Total tracked** | **~150 checkboxes** |

*Generated for mechanical OTP enablement — not a new investigation. Refresh from live `pg_proc` if RPCs are added after 2026-07-25.*
