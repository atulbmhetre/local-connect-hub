/**
 * Generate docs/BACKEND_INVENTORY.md from parsed migration data + src RPC grep map.
 */
import fs from 'node:fs';
import path from 'node:path';

const data = JSON.parse(fs.readFileSync('scripts/_backend_inventory_data.json', 'utf8'));

// Client RPC call sites (manual grep 2026-07-08)
const clientCalls = {
  add_bill_to_khata: ['src/components/IncomingOrdersSection.tsx'],
  admin_apply_vendor_waiveoff: ['src/pages/Settings.tsx'],
  admin_approve_category: ['src/pages/Settings.tsx'],
  admin_ban_user: ['src/pages/Settings.tsx'],
  admin_ban_vendor: ['src/pages/Settings.tsx'],
  admin_delete_review: ['src/pages/Settings.tsx'],
  admin_get_user_lang: ['src/lib/warnFlaggedUser.ts'],
  admin_reject_category: ['src/pages/Settings.tsx'],
  admin_set_vendor_check: ['src/pages/Settings.tsx'],
  admin_unban_user: ['src/pages/Settings.tsx'],
  admin_unban_vendor: ['src/pages/Settings.tsx'],
  admin_unverify_vendor: ['src/pages/Settings.tsx'],
  admin_update_app_config: ['src/pages/Settings.tsx'],
  admin_verify_vendor: ['src/pages/Settings.tsx'],
  admin_warn_user: ['src/lib/warnFlaggedUser.ts'],
  attach_pending_category: ['src/lib/supabase.ts'],
  cancel_customer_order: ['src/pages/MyOrders.tsx'],
  claim_customer_payment: ['src/components/ParchiSheet.tsx', 'src/components/PaymentSheet.tsx'],
  clear_user_notifications: ['src/components/NotificationBell.tsx'],
  confirm_upi_payment: ['src/components/IncomingOrdersSection.tsx'],
  create_customer_request: ['src/components/ParchiSheet.tsx'],
  create_referred_user: ['src/lib/referral.ts'],
  delete_user_address: ['src/pages/Settings.tsx'],
  delete_user_devices_for_phone: ['src/pages/Settings.tsx'],
  delete_user_notification: ['src/components/NotificationBell.tsx'],
  dismiss_order: ['src/pages/MyOrders.tsx'],
  dispute_upi_payment: ['src/components/IncomingOrdersSection.tsx'],
  edit_customer_order: ['src/pages/MyOrders.tsx'],
  get_admin_dashboard_stats: ['src/pages/Settings.tsx'],
  get_feed_preferences: ['src/pages/Settings.tsx', 'src/pages/LocalFeed.tsx'],
  get_local_feed_posts: ['src/pages/LocalFeed.tsx'],
  get_recommendations_for_admin: ['src/pages/Settings.tsx'],
  get_user_device: ['src/hooks/useFeedNotificationsEnabled.ts', 'src/pages/LocalFeed.tsx'],
  get_user_notifications: ['src/components/NotificationBell.tsx'],
  get_vendor_customer_names: ['src/pages/LedgerView.tsx'],
  increment_user_orders: ['src/lib/supabase.ts'],
  increment_vendor_delivered: ['src/components/RadarVendorCard.tsx', 'src/components/RatingSheet.tsx'],
  increment_vendor_helped: ['src/components/RadarVendorCard.tsx', 'src/components/RatingSheet.tsx'],
  increment_vendor_issues: ['src/components/RatingSheet.tsx'],
  insert_bill_with_items: ['src/components/BillSheet.tsx', 'src/components/IncomingOrdersSection.tsx'],
  insert_user_address: ['src/components/ParchiSheet.tsx'],
  log_admin_action: ['src/lib/adminAudit.ts'],
  lookup_user_by_phone: ['src/components/FirstOpenFlow.tsx', 'src/components/PhoneEntrySheet.tsx', 'src/pages/Settings.tsx'],
  mark_user_notification_read: ['src/components/NotificationBell.tsx'],
  mark_user_notifications_read: ['src/components/NotificationBell.tsx'],
  migrate_device_requests_phone: ['src/lib/userIdentity.ts'],
  migrate_saved_vendors_phone: ['src/lib/userIdentity.ts'],
  recalculate_vendor_on_time_rate: ['src/components/IncomingOrdersSection.tsx'],
  recalculate_vendor_rating_stats: ['src/lib/vendorRating.ts'],
  record_user_referral_reward: ['src/lib/referral.ts'],
  register_vendor: ['src/lib/supabase.ts'],
  save_saved_vendor: ['src/components/RadarVendorCard.tsx'],
  set_feed_discovery_radius: ['src/pages/Settings.tsx'],
  set_user_device_feed_notifications: ['src/hooks/useFeedNotificationsEnabled.ts'],
  submit_customer_feed_post: ['src/pages/LocalFeed.tsx'],
  submit_feed_reply: ['src/pages/LocalFeed.tsx'],
  submit_vendor_review: ['src/components/RatingSheet.tsx'],
  submit_vendor_verification: ['src/pages/VendorMode.tsx'],
  unsave_saved_vendor: ['src/components/NeighbourSheet.tsx', 'src/components/RadarVendorCard.tsx'],
  update_user_address: ['src/pages/Settings.tsx'],
  update_user_device_location: ['src/lib/pushNotifications.ts'],
  update_vendor_review: ['src/pages/MyOrders.tsx'],
  upsert_app_user: ['src/lib/supabase.ts'],
  upsert_user_device: ['src/lib/pushNotifications.ts'],
  vendor_accept_order: ['src/components/IncomingOrdersSection.tsx'],
  vendor_cancel_order: ['src/components/IncomingOrdersSection.tsx'],
  vendor_clear_order_edited: ['src/components/IncomingOrdersSection.tsx'],
  vendor_confirm_appointment: ['src/components/IncomingOrdersSection.tsx'],
  vendor_decline_booking: ['src/components/IncomingOrdersSection.tsx'],
  vendor_delete_menu_item: ['src/components/settings/VendorSettings.tsx'],
  vendor_dismiss_requests: ['src/components/IncomingOrdersSection.tsx'],
  vendor_edit_bill: ['src/components/BillEditSheet.tsx'],
  vendor_fulfil_order: ['src/components/IncomingOrdersSection.tsx'],
  vendor_hide_feed_post: ['src/components/settings/VendorSettings.tsx'],
  vendor_insert_menu_items: ['src/components/settings/VendorSettings.tsx'],
  vendor_mark_bill_paid: ['src/components/IncomingOrdersSection.tsx'],
  vendor_mark_customer_khata_bills_paid: ['src/pages/LedgerView.tsx'],
  vendor_mark_sent_seen: ['src/components/IncomingOrdersSection.tsx'],
  vendor_post_offer: ['src/components/settings/VendorSettings.tsx'],
  vendor_promote_green_pending: ['src/lib/vendorGreenReady.ts'],
  vendor_record_khata_payment: ['src/pages/LedgerView.tsx'],
  vendor_record_khata_refund: ['src/pages/LedgerView.tsx'],
  vendor_reply_to_review: ['src/components/settings/VendorSettings.tsx'],
  vendor_submit_user_flag: ['src/components/IncomingOrdersSection.tsx'],
  vendor_toggle_menu_item_availability: ['src/components/settings/VendorSettings.tsx'],
  vendor_update_categories: ['src/pages/VendorMode.tsx'],
  vendor_update_customer_name: ['src/pages/LedgerView.tsx'],
  vendor_update_menu_item: ['src/components/settings/VendorSettings.tsx'],
  vendor_update_own: ['src/components/settings/VendorSettings.tsx', 'src/components/vendor/VendorNoteEditor.tsx', 'src/lib/pushNotifications.ts', 'src/lib/vendorPatch.ts', 'src/lib/vendorServiceRadius.ts', 'src/pages/VendorMode.tsx'],
  vendor_void_unpaid_bills: ['src/components/BillSheet.tsx'],
  increment_flag_count: ['src/pages/LocalFeed.tsx'],
};

function summarizeBody(body) {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'));
  const summary = [];
  for (const l of lines) {
    if (/^(INSERT|UPDATE|DELETE|SELECT|IF|RAISE|RETURN|PERFORM)/i.test(l)) summary.push(l.slice(0, 200));
    if (summary.length >= 8) break;
  }
  return summary.join(' ');
}

function identitySection(fn) {
  const body = fn.bodyPreview || '';
  const parts = [];
  if (/auth_user_phone\(\)/.test(body)) {
    parts.push('Uses `auth_user_phone()` (from `auth.users` via `auth.uid()`).');
  }
  if (/auth\.uid\(\)/.test(body)) parts.push('References `auth.uid()`.');
  if (/_vendor_owns_request/.test(body)) parts.push('Calls `_vendor_owns_request(...)`.');
  if (/_customer_owns_request|_customer_identity_ok/.test(body)) {
    parts.push('Calls customer ownership helper.');
  }
  if (/is_admin_phone|_admin_guard|admin_get/.test(body)) parts.push('Admin phone guard.');
  if (/p_vendor_phone/.test(body) && !/auth_user_phone/.test(body)) {
    parts.push('**FLAG:** uses `p_vendor_phone` parameter — verify independent session binding in body.');
  }
  if (/p_user_phone|p_phone/.test(body) && !/auth_user_phone/.test(body) && !/is_admin/.test(body)) {
    parts.push('**FLAG:** trusts `p_user_phone`/`p_phone` without obvious `auth_user_phone()` check in preview — read full body.');
  }
  if (/p_device_id/.test(body)) parts.push('Uses `p_device_id` parameter for device-scoped identity.');
  const wheres = body.match(/WHERE[^;]{0,180}/gi) || [];
  if (wheres.length) parts.push(`WHERE samples: \`${wheres.slice(0, 2).join('` | `')}\``);
  return parts.length ? parts.join(' ') : 'See SQL body in latest migration file.';
}

function grantsSection(fn) {
  if (fn.revoke && fn.grantAnon && fn.grantAuth) return 'REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO anon, authenticated.';
  const bits = [];
  if (!fn.revoke) bits.push('**FLAG: no REVOKE ALL FROM PUBLIC**');
  if (!fn.grantAnon && !fn.grantAuth) bits.push('**FLAG: no GRANT to anon/authenticated**');
  else {
    if (fn.grantAnon) bits.push('GRANT anon');
    if (fn.grantAuth) bits.push('GRANT authenticated');
    if (fn.grantService) bits.push('GRANT service_role');
  }
  return bits.join('; ');
}

function txnSection(fn) {
  const bits = [];
  if (fn.writes.length > 1) bits.push(`Multi-write (${fn.writes.join(', ')}) in one function body → atomic unless exception mid-function.`);
  else if (fn.writes.length === 1) bits.push(`Single-table write: ${fn.writes[0]}.`);
  else bits.push('No direct writes detected (may use helpers/triggers).');
  if (fn.multiWrite && !fn.hasForUpdate) bits.push('**FLAG:** SELECT-then-write pattern; no `FOR UPDATE` detected in preview — possible race on concurrent calls.');
  if (fn.hasForUpdate) bits.push('Uses `FOR UPDATE` row locking.');
  return bits.join(' ');
}

// Collect all tables from policies, indexes, function reads/writes
const allTables = new Set(data.tables);
for (const t of Object.keys(data.policies)) allTables.add(t);
for (const t of Object.keys(data.indexes)) allTables.add(t);
for (const fn of Object.values(data.functions)) {
  fn.reads?.forEach((t) => allTables.add(t));
  fn.writes?.forEach((t) => allTables.add(t));
}

let policyCount = 0;
for (const pols of Object.values(data.policies)) policyCount += Object.keys(pols).length;

let indexCount = 0;
for (const idxs of Object.values(data.indexes)) indexCount += Object.keys(idxs).length;

const lines = [];
lines.push('# Backend Inventory');
lines.push('');
lines.push('**Method:** All 149 SQL files under `supabase/migrations/` read in chronological order (final `CREATE OR REPLACE` definition wins). Client call sites from `grep .rpc(` in `src/` only.');
lines.push('');
lines.push('**Stats:**');
lines.push(`- Migration files read: **${data.migrationFiles}**`);
lines.push(`- RPC/functions catalogued: **${data.functionCount}**`);
lines.push(`- Tables referenced in final policy/index/function map: **${allTables.size}**`);
lines.push(`- RLS policies catalogued: **${policyCount}**`);
lines.push(`- Indexes catalogued: **${indexCount}**`);
lines.push('');
lines.push('---');
lines.push('');
lines.push('## RPC / Function Catalog');
lines.push('');

const fnNames = Object.keys(data.functions).sort();
for (const name of fnNames) {
  const fn = data.functions[name];
  const sig = fn.params.map((p) => (p.name ? `${p.name} ${p.type}` : p.raw)).join(', ');
  lines.push(`### \`${name}(${sig})\``);
  lines.push('');
  lines.push(`- **Latest migration:** \`${fn.file}\``);
  lines.push(`- **Language:** ${fn.lang}; **SECURITY DEFINER:** ${fn.secDef ? 'yes' : 'no'}${fn.secDef ? `; **search_path:** ${fn.searchPath ?? '**NOT SET — FLAG**'}` : ''}`);
  lines.push(`- **What it does:** ${summarizeBody(fn.bodyPreview) || '(see migration file)'}`);
  lines.push(`- **Tables read:** ${fn.reads.length ? fn.reads.join(', ') : '—'}`);
  lines.push(`- **Tables written:** ${fn.writes.length ? fn.writes.join(', ') : '—'}`);
  lines.push(`- **Identity verification:** ${identitySection(fn)}`);
  lines.push(`- **Grants:** ${grantsSection(fn)}`);
  lines.push(`- **Transactional integrity:** ${txnSection(fn)}`);
  const called = clientCalls[name];
  lines.push(`- **Called from src/:** ${called ? called.join(', ') : '**Not called from src/** (cron/trigger/internal only)'}`);
  const suspicious = [];
  if (!called && !name.startsWith('_') && !['auth_user_phone', 'expire_pending_orders', 'warn_pending_orders_near_deadline', 'anonymise_deleted_accounts', 'audit_anon_open_rls_policies', 'notify_order_bill_trigger', 'set_request_fulfilled_at', 'set_requests_updated_at', 'prevent_direct_admin_column_writes', 'check_bill_before_fulfil'].includes(name)) {
    suspicious.push('No src/ RPC call site');
  }
  if (fn.secDef && !fn.searchPath) suspicious.push('SECURITY DEFINER without SET search_path');
  if (!fn.revoke) suspicious.push('Missing REVOKE ALL FROM PUBLIC');
  if (suspicious.length) lines.push(`- **Suspicious:** ${suspicious.join('; ')}`);
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('## Table RLS Policies (final state from migrations)');
lines.push('');

const policyTables = Object.keys(data.policies).sort();
for (const table of policyTables) {
  const pols = data.policies[table];
  const rls = data.rlsEnabled[table];
  lines.push(`### \`${table}\``);
  lines.push('');
  lines.push(`- **RLS enabled (last migration touch):** ${rls === false ? '**DISABLED — FLAG**' : rls === true ? 'yes' : 'unknown/not altered in parsed migrations'}`);
  if (!pols || !Object.keys(pols).length) {
    lines.push('- **Policies:** none captured in migration parser (may rely on earlier schema or no RLS)');
    lines.push('');
    continue;
  }
  for (const [pname, p] of Object.entries(pols)) {
    lines.push(`- **\`${pname}\`** (${p.cmd})`);
    if (p.using) lines.push(`  - USING: \`${p.using}\``);
    if (p.with_check) lines.push(`  - WITH CHECK: \`${p.with_check}\``);
    const open = (p.using && /(?:^|\s)true(\s|$)/i.test(p.using)) || (p.with_check && /(?:^|\s)true(\s|$)/i.test(p.with_check));
    if (open) lines.push('  - **FLAG: permissive true policy**');
    if (p.using && !/auth_user_phone|auth\.uid|is_admin|device_id|user_phone|vendor_id/i.test(p.using)) {
      lines.push('  - **FLAG: USING does not obviously filter by identity**');
    }
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('## Indexes by Table');
lines.push('');

const keyTables = ['vendors', 'requests', 'khata_ledger', 'order_bills', 'vendor_reviews', 'feed_posts', 'users', 'saved_vendors', 'vendor_categories'];
for (const table of [...new Set([...keyTables, ...Object.keys(data.indexes)].sort())]) {
  const idxs = data.indexes[table];
  lines.push(`### \`${table}\``);
  if (!idxs || !Object.keys(idxs).length) {
    lines.push('- **Indexes (from migrations):** none declared in parsed migrations beyond PK (verify live schema)');
    if (keyTables.includes(table)) lines.push('- **FLAG:** key table — confirm PK-only in production');
  } else {
    for (const [iname, cols] of Object.entries(idxs)) {
      lines.push(`- \`${iname}\` ${cols}`);
    }
    if (table === 'vendors') {
      lines.push('- **FLAG:** no index on `phone` column in migrations (heavily used in RLS subqueries)');
    }
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('## Cross-cutting security notes');
lines.push('');
lines.push('- **`auth_user_phone()`** (latest `20260708000001`): strips leading `91` when digit length = 12 after non-digit removal; else returns raw `phone`. Client session uses anon key + localStorage phone; many RPCs trust `p_vendor_phone`/`p_user_phone` matching vendor row — session binding depends on caller passing correct phone.');
lines.push('- **Admin RPCs** gate on `is_admin_phone(auth_user_phone())` or equivalent in function body (see `20260618000006_admin_server_side_auth.sql`).');
lines.push('- **`register_vendor`** validates 10-digit phone + rate limit (`check_and_log_rate_limit`) as of `20260708000001`.');
lines.push('- **Cron/maintenance functions** (`expire_pending_orders`, `warn_pending_orders_near_deadline`, `anonymise_deleted_accounts`, subscription check crons): not called from src/; run via pg_cron.');
lines.push('- **Defense-in-depth:** Vendor/customer write RPCs (SECURITY DEFINER) bypass RLS; direct client INSERT/UPDATE on financial tables should be blocked by RLS — verify `khata_ledger_vendor` is SELECT-only for vendors after `20260630000001` (writes only via RPC).');
lines.push('- **Public SELECT policies:** `vendor_reviews_public_read`, `vendor_menu_items_public_read`, `vendors_public_read`, `categories_public_read`, `feed_posts_public_read` use `USING (true)` or `is_hidden = false` — intentional for radar/feed.');
lines.push('- **Triggers:** `notify_order_bill_trigger`, `set_requests_updated_at`, `set_request_fulfilled_at`, `prevent_direct_admin_column_writes` — internal, not client RPCs.');
lines.push('');
lines.push('*End of inventory. No files modified.*');

fs.writeFileSync('docs/BACKEND_INVENTORY.md', lines.join('\n'));
console.log('Wrote docs/BACKEND_INVENTORY.md', lines.length, 'lines');
