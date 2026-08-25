// seed-test-vendors.mjs
//
// Reusable TEST_ data tool. Location spread (Ausa / Chinchwad / …) still goes
// through register_vendor. Special account types are independently re-runnable
// via --type= and also use real RPCs / the delete-account edge function — no
// raw identity-table inserts for those paths.
//
// Usage:
//   node seed-test-vendors.mjs --project=test
//   node seed-test-vendors.mjs --project=prod --type=specials
//   node seed-test-vendors.mjs --project=prod --type=banned-vendor
//   node seed-test-vendors.mjs --project=prod --cleanup
//
// --type=
//   banned-vendor | deletion-scheduled-vendor | banned-customer | dual-role | specials
//
// Safe to re-run: creates NEW phones. Cleanup targets TEST_-prefixed vendors
// plus users/devices recorded in TEST_DATA_REGISTRY.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const REGISTRY_PATH = path.join(projectRoot, 'TEST_DATA_REGISTRY.md');
const STATE_PATH = path.join(projectRoot, 'TEST_DATA_REGISTRY.json');

const SPECIAL_TYPES = [
  'banned-vendor',
  'deletion-scheduled-vendor',
  'banned-customer',
  'dual-role',
];

function parseArgs(argv) {
  const args = { project: 'test', type: null, cleanup: false, help: false };
  for (const raw of argv) {
    if (raw === '--cleanup') args.cleanup = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--project=')) args.project = raw.split('=')[1];
    else if (raw.startsWith('--type=')) args.type = raw.split('=')[1];
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
  console.log(`Usage:
  node seed-test-vendors.mjs --project=test|prod
  node seed-test-vendors.mjs --project=test|prod --type=banned-vendor|deletion-scheduled-vendor|banned-customer|dual-role|specials
  node seed-test-vendors.mjs --project=test|prod --cleanup`);
  process.exit(0);
}
if (cli.project !== 'test' && cli.project !== 'prod') {
  console.error('Usage: node seed-test-vendors.mjs --project=test|prod [--type=...] [--cleanup]');
  process.exit(1);
}
if (cli.type && cli.type !== 'specials' && !SPECIAL_TYPES.includes(cli.type)) {
  console.error(`Unknown --type=${cli.type}. Want: ${SPECIAL_TYPES.join('|')}|specials`);
  process.exit(1);
}

const envFile = cli.project === 'prod' ? '.env.test.prod' : '.env.test';
const env = dotenv.parse(fs.readFileSync(path.join(projectRoot, envFile)));
dotenv.config({ path: path.join(projectRoot, '.env.local'), override: true });

const SUPABASE_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const TEST_REF = 'hhdylnhqdzfabsolwxdz';
const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const expectedRef = cli.project === 'prod' ? PROD_REF : TEST_REF;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(`Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`);
  process.exit(1);
}
if (!SUPABASE_URL.includes(expectedRef)) {
  console.error(`Refusing to run — expected ${cli.project} ref ${expectedRef}, got ${SUPABASE_URL}`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
console.log(`Target (${cli.project}): ${SUPABASE_URL}`);
console.log(`project_ref: ${expectedRef}`);

/** Same shape as src/lib/referral.ts referralCodeFromPhone. */
function referralCodeFromPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `AASP${last4}`;
}

const LOCATIONS = [
  { name: 'Hyderabad', lat: 17.385, lng: 78.4867 },
  { name: 'Pune-Chinchwad', lat: 18.6298, lng: 73.7997 },
  { name: 'Ausa', lat: 18.25, lng: 76.49 },
  { name: 'Navi-Mumbai', lat: 19.033, lng: 73.0297 },
];

const SPECIAL_LOCATION = LOCATIONS.find((l) => l.name === 'Pune-Chinchwad');

function jitter(base, km = 2) {
  const deg = km / 111;
  return base + (Math.random() * 2 - 1) * deg;
}

const SHOP_PHOTO = (label) => `https://placehold.co/600x400?text=${encodeURIComponent(label)}`;
const MENU_PHOTO = (label) => `https://placehold.co/300x300?text=${encodeURIComponent(label)}`;

let phoneCounter = 9000000000 + (Date.now() % 89000000);
function nextPhone() {
  const n = phoneCounter++;
  const tail = String(n).slice(-9);
  return `9${tail}`;
}

function nextSpecialPhone() {
  const tail = String(Date.now() + Math.floor(Math.random() * 900)).slice(-6);
  return `6998${tail}`.slice(0, 10);
}

const ALL_CHECK_TYPES = [
  'upi_format',
  'upi_pennydrop',
  'photo_shop',
  'photo_selfie',
  'gps',
  'admin_check',
  'aadhaar_digilocker',
];

async function insertVerificationChecks(vendorId, passedTypes) {
  const rows = ALL_CHECK_TYPES.map((check_type) => ({
    vendor_id: vendorId,
    check_type,
    status: passedTypes.includes(check_type) ? 'passed' : 'pending',
    checked_at: passedTypes.includes(check_type) ? new Date().toISOString() : null,
    checked_by: passedTypes.includes(check_type) ? 'seed_script' : null,
    is_latest: true,
  }));
  await sb.from('vendor_verification').delete().eq('vendor_id', vendorId);
  const { error } = await sb.from('vendor_verification').insert(rows);
  if (error) console.error('  verification insert error:', error.message);
}

function buildBlueprints(loc) {
  return [
    {
      tag: 'Gold-FullyVerified-Help-15km',
      shop_name: `TEST_${loc.name}_GoldElectrician`,
      name: `${loc.name} Test Electrician (Gold)`,
      categories: ['Electrician'],
      isManualVerified: true,
      checksPassed: ['upi_format', 'photo_shop', 'photo_selfie', 'gps', 'admin_check', 'upi_pennydrop'],
      khata: { amber: 500, red: 1000 },
      hasMenu: true,
      menuHasPhotos: true,
      isActive: true,
      avgRating: 4.7,
      reviewCount: 23,
      serviceRadius: 15,
      servesVendorPlace: true,
      servesCustomerPlace: true,
      modes: ['help'],
    },
    {
      tag: 'Unverified-NoMenu-Delivery-5km',
      shop_name: `TEST_${loc.name}_UnverifiedGrocery`,
      name: `${loc.name} Test Grocery (Unverified)`,
      categories: ['Grocery'],
      isManualVerified: false,
      checksPassed: [],
      khata: { amber: 0, red: 0 },
      hasMenu: false,
      menuHasPhotos: false,
      isActive: false,
      avgRating: null,
      reviewCount: 0,
      serviceRadius: 5,
      servesVendorPlace: true,
      servesCustomerPlace: false,
      modes: ['delivery'],
    },
    {
      tag: 'Multi-Category-Partial-30km',
      shop_name: `TEST_${loc.name}_MultiServicePartial`,
      name: `${loc.name} Test Multi-Service (Partial)`,
      categories: ['Plumber', 'Painter', 'Carpenter'],
      isManualVerified: false,
      checksPassed: ['photo_shop', 'gps'],
      khata: { amber: 300, red: 700 },
      hasMenu: true,
      menuHasPhotos: false,
      isActive: true,
      avgRating: 3.8,
      reviewCount: 6,
      serviceRadius: 30,
      servesVendorPlace: true,
      servesCustomerPlace: true,
      modes: ['help'],
    },
    {
      tag: 'Appointment-PendingAdmin-1km',
      shop_name: `TEST_${loc.name}_TinyRadiusBarber`,
      name: `${loc.name} Test Barber (Tiny Radius)`,
      categories: ['Barber'],
      isManualVerified: false,
      checksPassed: ['photo_shop'],
      khata: { amber: 0, red: 0 },
      hasMenu: true,
      menuHasPhotos: false,
      isActive: true,
      avgRating: 4.1,
      reviewCount: 4,
      serviceRadius: 1,
      servesVendorPlace: true,
      servesCustomerPlace: false,
      modes: ['appointment'],
    },
    {
      tag: 'LowRated-Mechanic-50km',
      shop_name: `TEST_${loc.name}_LowRatedMechanic`,
      name: `${loc.name} Test Mechanic (Low Rated)`,
      categories: ['Mechanic'],
      isManualVerified: false,
      checksPassed: ['gps', 'photo_shop'],
      khata: { amber: 200, red: 500 },
      hasMenu: true,
      menuHasPhotos: false,
      isActive: true,
      avgRating: 2.1,
      reviewCount: 11,
      serviceRadius: 50,
      servesVendorPlace: true,
      servesCustomerPlace: true,
      modes: ['help'],
    },
    {
      tag: 'Diamond-Pharmacy-100km',
      shop_name: `TEST_${loc.name}_DiamondPharmacy`,
      name: `${loc.name} Test Pharmacy (Diamond)`,
      categories: ['Pharmacy'],
      isManualVerified: true,
      checksPassed: ['upi_format', 'photo_shop', 'photo_selfie', 'gps', 'admin_check', 'upi_pennydrop'],
      khata: { amber: 1000, red: 2000 },
      hasMenu: true,
      menuHasPhotos: true,
      isActive: true,
      avgRating: 4.9,
      reviewCount: 40,
      serviceRadius: 100,
      servesVendorPlace: false,
      servesCustomerPlace: true,
      modes: ['delivery'],
    },
    {
      tag: 'PanIndia-Gold-Tutor',
      shop_name: `TEST_${loc.name}_PanIndiaTutor`,
      name: `${loc.name} Test Tutor (Pan-India)`,
      categories: ['Tutor'],
      isManualVerified: true,
      checksPassed: ['upi_format', 'photo_shop', 'photo_selfie', 'gps', 'admin_check', 'upi_pennydrop'],
      khata: { amber: 0, red: 0 },
      hasMenu: true,
      menuHasPhotos: true,
      isActive: true,
      avgRating: 4.6,
      reviewCount: 17,
      serviceRadius: 9999,
      servesVendorPlace: false,
      servesCustomerPlace: true,
      modes: ['appointment'],
    },
  ];
}

const MENU_ITEMS_BY_MODE = {
  help: [
    { name: 'Service call-out', unit: 'visit', price: 150 },
    { name: 'Repair — minor', unit: 'job', price: 300 },
    { name: 'Repair — major', unit: 'job', price: 800 },
  ],
  delivery: [
    { name: 'Delivery — standard', unit: 'order', price: 0 },
    { name: 'Rush delivery', unit: 'order', price: 30 },
  ],
  appointment: [
    { name: 'Standard session', unit: 'session', price: 400 },
    { name: 'Premium session', unit: 'session', price: 900 },
  ],
};

async function loadCategoriesByLabel() {
  const { data, error } = await sb
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true);
  if (error) throw error;
  const map = new Map();
  for (const row of data ?? []) {
    map.set(row.label, { id: row.id, mode: row.service_mode, label: row.label });
  }
  return map;
}

async function seedVendor(loc, bp, categoriesByLabel) {
  const primaryLabel = bp.categories[0];
  const primaryCategory = categoriesByLabel.get(primaryLabel);
  if (!primaryCategory) {
    console.error(`  [${bp.tag}] missing category on ${cli.project}: ${primaryLabel}`);
    return null;
  }

  const categoryIds = [];
  const categoryServiceModes = [];
  const categoryModes = {};
  for (const label of bp.categories) {
    const cat = categoriesByLabel.get(label);
    if (!cat) {
      console.error(`  [${bp.tag}] skip — missing category ${label}`);
      return null;
    }
    categoryIds.push(cat.id);
    const modes = bp.modes?.length ? bp.modes : [cat.mode];
    categoryServiceModes.push(modes[0] || cat.mode);
    categoryModes[cat.id] = modes;
  }

  const phone = nextPhone();
  const lat = jitter(loc.lat);
  const lng = jitter(loc.lng);
  const primaryMode = categoryServiceModes[0];

  const { data: vendorId, error: regErr } = await sb.rpc('register_vendor', {
    p_name: bp.name,
    p_shop_name: bp.shop_name,
    p_category: primaryLabel,
    p_phone: phone,
    p_upi_id: `${bp.shop_name.toLowerCase().replace(/[^a-z0-9]/g, '')}@upi`.slice(0, 40),
    p_service_mode: primaryMode,
    p_vendor_type: 'shop',
    p_vendor_note: null,
    p_latitude: lat,
    p_longitude: lng,
    p_referral_code: referralCodeFromPhone(phone),
    p_profile_status: 'complete',
    p_category_ids: categoryIds,
    p_category_service_modes: categoryServiceModes,
    p_category_modes: categoryModes,
    p_upi_qr_url: null,
    p_upi_qr_payee_id: null,
    p_base_type: 'shop',
    p_serves_at_vendor_place: bp.servesVendorPlace,
    p_serves_at_customer_place: bp.servesCustomerPlace,
    p_service_radius_km: bp.serviceRadius,
    p_availability_modes: bp.modes,
  });

  if (regErr || !vendorId) {
    console.error(`  [${bp.tag}] register_vendor failed:`, regErr?.message ?? 'empty id');
    return null;
  }
  console.log(`  [${bp.tag}] register_vendor ok: ${vendorId}`);

  const { error: patchErr } = await sb
    .from('vendors')
    .update({
      is_active: bp.isActive,
      verification_status: bp.isManualVerified ? 'verified' : 'unverified',
      is_manual_verified: bp.isManualVerified,
      upi_verified: bp.checksPassed.includes('upi_pennydrop'),
      khata_amber_limit: bp.khata.amber,
      khata_red_limit: bp.khata.red,
      service_radius_km: bp.serviceRadius,
      discoverable: true,
      shop_photo_url: bp.checksPassed.includes('photo_shop') ? SHOP_PHOTO(bp.shop_name) : null,
      photo_selfie: bp.checksPassed.includes('photo_selfie')
        ? SHOP_PHOTO(`${bp.shop_name}_selfie`)
        : null,
      avg_rating: bp.avgRating,
      review_count: bp.reviewCount,
      serves_at_vendor_place: bp.servesVendorPlace,
      serves_at_customer_place: bp.servesCustomerPlace,
    })
    .eq('id', vendorId);
  if (patchErr) console.error('    vendor patch error:', patchErr.message);

  const { error: vcPatchErr } = await sb
    .from('vendor_categories')
    .update({
      service_radius_km: bp.serviceRadius,
      serves_at_vendor_place: bp.servesVendorPlace,
      serves_at_customer_place: bp.servesCustomerPlace,
      is_manual_verified: bp.isManualVerified,
      shop_photo_url: bp.checksPassed.includes('photo_shop') ? SHOP_PHOTO(bp.shop_name) : null,
      verification_status: bp.isManualVerified ? 'verified' : 'unverified',
    })
    .eq('vendor_id', vendorId);
  if (vcPatchErr) console.error('    vendor_categories patch error:', vcPatchErr.message);

  await insertVerificationChecks(vendorId, bp.checksPassed);

  if (bp.hasMenu) {
    const items = MENU_ITEMS_BY_MODE[primaryMode] || MENU_ITEMS_BY_MODE.help;
    const rows = items.map((item, idx) => ({
      vendor_id: vendorId,
      category_id: primaryCategory.id,
      name: item.name,
      description: `${item.name} — test menu item`,
      price: item.price,
      unit: item.unit,
      is_available: true,
      sort_order: idx,
      image_url: bp.menuHasPhotos ? MENU_PHOTO(item.name) : null,
    }));
    const { error: mErr } = await sb.from('vendor_menu_items').insert(rows);
    if (mErr) console.error('    menu_items insert error:', mErr.message);
  }

  const { data: vcIds } = await sb.from('vendor_categories').select('id').eq('vendor_id', vendorId);
  const ids = (vcIds ?? []).map((r) => r.id);
  const { data: modes } = ids.length
    ? await sb.from('vendor_category_modes').select('vendor_category_id, mode').in('vendor_category_id', ids)
    : { data: [] };
  if (!modes?.length) {
    console.error('    ERROR: vendor_category_modes empty after register_vendor — aborting seed');
    process.exit(1);
  }
  console.log(`    modes rows: ${modes.length} → ${JSON.stringify(modes.map((m) => m.mode))}`);

  return { vendorId, phone, shopName: bp.shop_name };
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { accounts: [], removed: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { accounts: [], removed: [] };
  }
}

function writeRegistry(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  const active = state.accounts ?? [];
  const removed = state.removed ?? [];
  const lines = [
    '# TEST data registry',
    '',
    'Synthetic accounts created by `seed-test-vendors.mjs`. Shop / owner names use the `TEST_` prefix. Phones are 10-digit Indian mobiles reserved for this tool (`6998…` for special types), not real people.',
    '',
    `- **Last updated:** ${new Date().toISOString()}`,
    `- **Last project:** ${cli.project} (\`${expectedRef}\`)`,
    '',
    '## Active',
    '',
  ];
  if (!active.length) {
    lines.push('_None._', '');
  } else {
    lines.push(
      '| created_at | project | type | purpose | phone | id | shop_or_name | device_id |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const row of active) {
      lines.push(
        `| ${row.created_at} | ${row.project} | ${row.type} | ${row.purpose} | ${row.phone} | ${row.id ?? ''} | ${row.shop_or_name ?? ''} | ${row.device_id ?? ''} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Removed', '');
  if (!removed.length) {
    lines.push('_None._', '');
  } else {
    lines.push(
      '| removed_at | project | type | phone | id | shop_or_name | how |',
      '|---|---|---|---|---|---|---|',
    );
    for (const row of removed.slice(-50)) {
      lines.push(
        `| ${row.removed_at} | ${row.project} | ${row.type} | ${row.phone} | ${row.id ?? ''} | ${row.shop_or_name ?? ''} | ${row.how ?? ''} |`,
      );
    }
    lines.push('');
  }
  fs.writeFileSync(REGISTRY_PATH, `${lines.join('\n')}\n`);
}

function recordAccount(entry) {
  const state = loadState();
  state.accounts = state.accounts ?? [];
  state.accounts.push({
    created_at: new Date().toISOString(),
    project: cli.project,
    project_ref: expectedRef,
    ...entry,
  });
  writeRegistry(state);
}

async function countNonTestVendors() {
  const { count, error } = await sb
    .from('vendors')
    .select('id', { count: 'exact', head: true })
    .not('shop_name', 'like', 'TEST_%');
  if (error) throw error;
  return count ?? 0;
}

async function registerSpecialVendor({ shopName, ownerName, note, categoriesByLabel }) {
  const cat = categoriesByLabel.get('Electrician') ?? [...categoriesByLabel.values()][0];
  if (!cat) throw new Error('No active category available for special vendor seed');
  const phone = nextSpecialPhone();
  const loc = SPECIAL_LOCATION;
  const mode = cat.mode || 'help';
  const { data: vendorId, error } = await sb.rpc('register_vendor', {
    p_name: ownerName,
    p_shop_name: shopName,
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: `${shopName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}@upi`,
    p_service_mode: mode,
    p_vendor_type: 'shop',
    p_vendor_note: note,
    p_latitude: loc.lat,
    p_longitude: loc.lng,
    p_referral_code: referralCodeFromPhone(phone),
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: [mode],
    p_category_modes: { [cat.id]: [mode] },
    p_upi_qr_url: null,
    p_upi_qr_payee_id: null,
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: true,
    p_service_radius_km: 15,
    p_availability_modes: [mode],
  });
  if (error || !vendorId) {
    throw new Error(`register_vendor failed: ${error?.message ?? 'empty id'}`);
  }
  return { vendorId, phone, shopName, categoryLabel: cat.label };
}

async function upsertCustomer(phone) {
  const { error } = await sb.rpc('upsert_app_user', { p_phone: phone, p_lang: 'en' });
  if (error) throw new Error(`upsert_app_user failed: ${error.message}`);
}

async function ensureDevice(phone, deviceId) {
  const { error } = await sb.rpc('ensure_user_device_link', {
    p_user_phone: phone,
    p_device_id: deviceId,
  });
  if (error) throw new Error(`ensure_user_device_link failed: ${error.message}`);
}

async function invokeDeleteAccount({ phone, type, deviceId, action }) {
  if (!ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY required to call delete-account');
  const body = action === 'cancel' ? { phone, action: 'cancel', device_id: deviceId } : { phone, type, device_id: deviceId };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(`delete-account failed (${res.status}): ${json?.error ?? JSON.stringify(json)}`);
  }
  return json;
}

async function getAdminRpcClient() {
  if (!ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY required for admin session RPCs');
  const email =
    (process.env.TEST_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim() ||
    'seed-test-vendors-admin@aaspaas.test';
  const password =
    (process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '').trim() ||
    'SeedTestVendorsAdmin!20260825';

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: signErr } = await anon.auth.signInWithPassword({ email, password });
  if (!signErr) {
    const { data: sessionData } = await anon.auth.getUser();
    if (sessionData?.user?.id) {
      await sb.from('admin_users').upsert({ user_id: sessionData.user.id }, { onConflict: 'user_id' });
      return anon;
    }
  }

  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) {
    const msg = createErr.message.toLowerCase();
    if (!msg.includes('already') && !msg.includes('registered') && !msg.includes('exists')) {
      throw new Error(`admin createUser failed: ${createErr.message}`);
    }
  }
  const { data: signedIn, error: retryErr } = await anon.auth.signInWithPassword({ email, password });
  const userId = signedIn?.user?.id ?? created?.user?.id;
  if (retryErr || !userId) {
    throw new Error(
      `Could not establish admin session (${retryErr?.message ?? createErr?.message ?? 'no user'}). ` +
        'Set TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD for this project.',
    );
  }
  const { error: upsertErr } = await sb
    .from('admin_users')
    .upsert({ user_id: userId }, { onConflict: 'user_id' });
  if (upsertErr) throw new Error(`admin_users upsert failed: ${upsertErr.message}`);
  return anon;
}

async function seedBannedVendor(categoriesByLabel) {
  const shopName = 'TEST_BannedVendor_Chinchwad';
  const created = await registerSpecialVendor({
    shopName,
    ownerName: 'TEST_BannedVendor Owner',
    note: 'TEST_ special: banned-vendor',
    categoriesByLabel,
  });
  const admin = await getAdminRpcClient();
  const { error } = await admin.rpc('admin_ban_vendor', {
    p_admin_phone: 'seed-test-vendors',
    p_vendor_id: created.vendorId,
    p_reason: 'TEST_ seed: banned-vendor fixture',
  });
  if (error) throw new Error(`admin_ban_vendor failed: ${error.message}`);
  recordAccount({
    type: 'banned-vendor',
    purpose: 'Admin ban/unban + banned-vendor restore denial',
    phone: created.phone,
    id: created.vendorId,
    shop_or_name: shopName,
  });
  console.log(`  banned-vendor ${created.vendorId} phone=${created.phone}`);
  return created;
}

async function seedDeletionScheduledVendor(categoriesByLabel) {
  const shopName = 'TEST_DeletionScheduled_Chinchwad';
  const created = await registerSpecialVendor({
    shopName,
    ownerName: 'TEST_DeletionScheduled Owner',
    note: 'TEST_ special: deletion-scheduled-vendor',
    categoriesByLabel,
  });
  const deviceId = `test-del-${created.phone}`;
  // Device link only — do not upsert a users row. Vendor delete-account with a
  // users row is treated as dual-role and calls anonymise_deleted_accounts.
  await ensureDevice(created.phone, deviceId);
  await invokeDeleteAccount({ phone: created.phone, type: 'vendor', deviceId });
  recordAccount({
    type: 'deletion-scheduled-vendor',
    purpose: '30-day deletion window + admin_force_clear_deletion',
    phone: created.phone,
    id: created.vendorId,
    shop_or_name: shopName,
    device_id: deviceId,
  });
  console.log(`  deletion-scheduled-vendor ${created.vendorId} phone=${created.phone}`);
  return created;
}

async function seedBannedCustomer() {
  const phone = nextSpecialPhone();
  const deviceId = `test-ban-cust-${phone}`;
  await upsertCustomer(phone);
  await ensureDevice(phone, deviceId);
  const admin = await getAdminRpcClient();
  const { error } = await admin.rpc('admin_ban_user', {
    p_admin_phone: 'seed-test-vendors',
    p_user_phone: phone,
    p_reason: 'TEST_ seed: banned-customer fixture',
  });
  if (error) throw new Error(`admin_ban_user failed: ${error.message}`);
  recordAccount({
    type: 'banned-customer',
    purpose: 'Customer ban on FirstOpen / order attempt',
    phone,
    id: phone,
    shop_or_name: 'TEST_BannedCustomer',
    device_id: deviceId,
  });
  console.log(`  banned-customer phone=${phone}`);
  return { phone };
}

async function seedDualRole(categoriesByLabel) {
  const shopName = 'TEST_DualRole_Chinchwad';
  const phone = nextSpecialPhone();
  const deviceId = `test-dual-${phone}`;
  await upsertCustomer(phone);
  await ensureDevice(phone, deviceId);
  const cat = categoriesByLabel.get('Grocery') ?? [...categoriesByLabel.values()][0];
  if (!cat) throw new Error('No active category for dual-role seed');
  const mode = cat.mode || 'delivery';
  const loc = SPECIAL_LOCATION;
  const { data: vendorId, error } = await sb.rpc('register_vendor', {
    p_name: 'TEST_DualRole Owner',
    p_shop_name: shopName,
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: `testdual${phone.slice(-4)}@upi`,
    p_service_mode: mode,
    p_vendor_type: 'shop',
    p_vendor_note: 'TEST_ special: dual-role FO-10',
    p_latitude: loc.lat,
    p_longitude: loc.lng,
    p_referral_code: referralCodeFromPhone(phone),
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: [mode],
    p_category_modes: { [cat.id]: [mode] },
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: true,
    p_service_radius_km: 15,
    p_availability_modes: [mode],
  });
  if (error || !vendorId) {
    throw new Error(`dual-role register_vendor failed: ${error?.message ?? 'empty id'}`);
  }
  recordAccount({
    type: 'dual-role',
    purpose: 'FO-10 same phone is customer + vendor',
    phone,
    id: vendorId,
    shop_or_name: shopName,
    device_id: deviceId,
  });
  console.log(`  dual-role ${vendorId} phone=${phone}`);
  return { vendorId, phone };
}

async function deleteVendorTree(vendorId) {
  const { data: requestRows } = await sb.from('requests').select('id').eq('vendor_id', vendorId);
  const requestIds = (requestRows ?? []).map((r) => r.id);
  if (requestIds.length) {
    await sb.from('order_bills').delete().in('request_id', requestIds);
    await sb.from('vendor_reviews').delete().in('request_id', requestIds);
    await sb.from('requests').delete().in('id', requestIds);
  }
  await sb.from('vendor_menu_items').delete().eq('vendor_id', vendorId);
  await sb.from('vendor_credits').delete().eq('vendor_id', vendorId);
  await sb.from('feed_posts').delete().eq('vendor_id', vendorId);
  await sb.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await sb.from('vendor_verification').delete().eq('vendor_id', vendorId);
  await sb.from('admin_actions').delete().eq('target_id', vendorId);
  const { error } = await sb.from('vendors').delete().eq('id', vendorId);
  if (error) throw new Error(`vendors delete ${vendorId}: ${error.message}`);
}

async function runCleanup() {
  console.log('\n=== --cleanup (TEST_ prefix + registry phones) ===');
  console.log(`
What cleanup CAN do:
  - admin_force_clear_deletion on TEST_ vendors still in the 30-day window (no wait)
  - Direct dependent-row + vendor delete for TEST_-prefixed shops (same as cleanup-test-vendors.mjs)
  - Direct users / user_devices / app_users delete for registry phones and TEST_ vendor phones

What cleanup will NOT do:
  - Invoke anonymise_deleted_accounts (that scans every account past 30 days — not TEST_-scoped)
  - Call delete-account type=customer (that also kicks the global anonymise RPC)
  - Touch vendors whose shop_name does not start with TEST_
`);

  const beforeReal = await countNonTestVendors();
  let admin = null;
  try {
    admin = await getAdminRpcClient();
  } catch (err) {
    console.warn('  admin session unavailable — scheduled-deletion vendors will be force-deleted without RPC clear:', err.message);
  }

  const { data: testVendors, error: findErr } = await sb
    .from('vendors')
    .select('id, shop_name, phone, deletion_requested_at')
    .like('shop_name', 'TEST_%');
  if (findErr) throw findErr;

  const vendorPhones = new Set();
  for (const v of testVendors ?? []) {
    if (v.phone) vendorPhones.add(v.phone);
    if (v.deletion_requested_at && admin) {
      const { error } = await admin.rpc('admin_force_clear_deletion', {
        p_vendor_id: v.id,
        p_notes: 'TEST_ seed-test-vendors --cleanup (skip 30-day wait)',
      });
      if (error && !String(error.message).includes('no_deletion_pending')) {
        console.warn(`  force-clear ${v.id}: ${error.message}`);
      } else {
        console.log(`  force-cleared deletion on ${v.shop_name}`);
      }
    }
  }

  for (const v of testVendors ?? []) {
    await deleteVendorTree(v.id);
    console.log(`  removed vendor ${v.shop_name} (${v.id})`);
  }

  const state = loadState();
  const registryPhones = new Set(
    (state.accounts ?? [])
      .filter((a) => a.project === cli.project)
      .map((a) => a.phone)
      .filter(Boolean),
  );
  const phones = [...new Set([...vendorPhones, ...registryPhones])];
  if (phones.length) {
    await sb.from('user_devices').delete().in('user_phone', phones);
    await sb.from('user_addresses').delete().in('user_phone', phones);
    await sb.from('app_users').delete().in('phone', phones);
    await sb.from('users').delete().in('phone', phones);
    console.log(`  removed users/devices for ${phones.length} TEST_ phones`);
  }

  const afterReal = await countNonTestVendors();
  if (afterReal !== beforeReal) {
    throw new Error(
      `Cleanup changed non-TEST_ vendor count (${beforeReal} → ${afterReal}). Aborting registry update.`,
    );
  }

  const removedAt = new Date().toISOString();
  const kept = [];
  const newlyRemoved = [];
  for (const row of state.accounts ?? []) {
    if (row.project === cli.project) {
      newlyRemoved.push({ ...row, removed_at: removedAt, how: 'seed-test-vendors --cleanup' });
    } else {
      kept.push(row);
    }
  }
  state.accounts = kept;
  state.removed = [...(state.removed ?? []), ...newlyRemoved];
  writeRegistry(state);
  console.log(`\nCleanup complete. non-TEST_ vendor count unchanged: ${afterReal}`);
}

async function runLocationSpread(categoriesByLabel) {
  let total = 0;
  let ok = 0;
  for (const loc of LOCATIONS) {
    console.log(`\n=== ${loc.name} ===`);
    for (const bp of buildBlueprints(loc)) {
      total++;
      const result = await seedVendor(loc, bp, categoriesByLabel);
      if (result) {
        ok++;
        recordAccount({
          type: 'location-spread',
          purpose: bp.tag,
          phone: result.phone,
          id: result.vendorId,
          shop_or_name: result.shopName,
        });
      }
    }
  }
  console.log(`\nDone. register_vendor succeeded for ${ok}/${total} blueprints on ${cli.project}.`);
}

async function runSpecials(types, categoriesByLabel) {
  const beforeReal = await countNonTestVendors();
  for (const type of types) {
    console.log(`\n=== ${type} ===`);
    if (type === 'banned-vendor') await seedBannedVendor(categoriesByLabel);
    else if (type === 'deletion-scheduled-vendor') await seedDeletionScheduledVendor(categoriesByLabel);
    else if (type === 'banned-customer') await seedBannedCustomer();
    else if (type === 'dual-role') await seedDualRole(categoriesByLabel);
  }
  const afterReal = await countNonTestVendors();
  if (afterReal !== beforeReal) {
    throw new Error(`Special seed changed non-TEST_ vendor count (${beforeReal} → ${afterReal})`);
  }
  console.log(`\nSpecials done. non-TEST_ vendor count unchanged: ${afterReal}`);
}

async function main() {
  if (cli.cleanup) {
    await runCleanup();
    return;
  }
  const categoriesByLabel = await loadCategoriesByLabel();
  if (cli.type === 'specials') {
    await runSpecials(SPECIAL_TYPES, categoriesByLabel);
    return;
  }
  if (cli.type) {
    await runSpecials([cli.type], categoriesByLabel);
    return;
  }
  await runLocationSpread(categoriesByLabel);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
