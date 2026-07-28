// seed-test-vendors.mjs
//
// Creates a spread of realistic, varied TEST_-prefixed vendors near each of
// Atul's real tester locations via the real register_vendor RPC (so
// vendor_category_modes always match production registration).
//
// Run with:
//   node seed-test-vendors.mjs --project=test
//   node seed-test-vendors.mjs --project=prod   # only when explicitly approved
//
// Safe to re-run: creates NEW vendors (time-based phones). Cleanup:
// delete vendors where shop_name LIKE 'TEST_%'.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const args = process.argv.slice(2);
const projectArg = (args.find((a) => a.startsWith('--project=')) ?? '').split('=')[1] || 'test';
if (projectArg !== 'test' && projectArg !== 'prod') {
  console.error('Usage: node seed-test-vendors.mjs --project=test|prod');
  process.exit(1);
}

const envFile = projectArg === 'prod' ? '.env.test.prod' : '.env.test';
const env = dotenv.parse(fs.readFileSync(path.join(projectRoot, envFile)));
dotenv.config({ path: path.join(projectRoot, '.env.local'), override: true });

const SUPABASE_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_REF = 'hhdylnhqdzfabsolwxdz';
const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const expectedRef = projectArg === 'prod' ? PROD_REF : TEST_REF;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(`Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`);
  process.exit(1);
}
if (!SUPABASE_URL.includes(expectedRef)) {
  console.error(`Refusing to run — expected ${projectArg} ref ${expectedRef}, got ${SUPABASE_URL}`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
console.log(`Target (${projectArg}): ${SUPABASE_URL}`);

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

function jitter(base, km = 2) {
  const deg = km / 111;
  return base + (Math.random() * 2 - 1) * deg;
}

const SHOP_PHOTO = (label) => `https://placehold.co/600x400?text=${encodeURIComponent(label)}`;
const MENU_PHOTO = (label) => `https://placehold.co/300x300?text=${encodeURIComponent(label)}`;

let phoneCounter = 9000000000 + (Date.now() % 89000000);
function nextPhone() {
  // Valid Indian mobile starting 6–9
  const n = phoneCounter++;
  const tail = String(n).slice(-9);
  return `9${tail}`;
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
  // register_vendor already inserts dormant/passed rows — replace with seed state
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
    console.error(`  [${bp.tag}] missing category on ${projectArg}: ${primaryLabel}`);
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

  // Enrich beyond what registration writes (test-scenario fields).
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
  console.log(
    `    modes rows: ${modes.length} → ${JSON.stringify(modes.map((m) => m.mode))}`,
  );

  return vendorId;
}

async function main() {
  const categoriesByLabel = await loadCategoriesByLabel();
  let total = 0;
  let ok = 0;
  for (const loc of LOCATIONS) {
    console.log(`\n=== ${loc.name} ===`);
    for (const bp of buildBlueprints(loc)) {
      total++;
      const id = await seedVendor(loc, bp, categoriesByLabel);
      if (id) ok++;
    }
  }
  console.log(`\nDone. register_vendor succeeded for ${ok}/${total} blueprints on ${projectArg}.`);
  console.log(`All shop names start with "TEST_" — filter on that prefix to clean up.`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
