/**
 * Phone-format violation cleanup + VALIDATE CONSTRAINT.
 * Usage: node scripts/cleanup-phone-violations.mjs test|prod|both
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const VALID = /^[6-9][0-9]{9}$/;
function isAllowedPhone(phone) {
  if (phone == null) return false;
  return VALID.test(phone) || phone.startsWith('deleted_');
}

function loadEnv(label) {
  const envFile = label === 'prod' ? '.env.test.prod' : '.env.test';
  dotenv.config({ path: path.join(projectRoot, envFile) });
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error(`Missing credentials in ${envFile}`);
  return { url, key, ref: url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] };
}

async function fetchAllVendors(admin) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await admin
      .from('vendors')
      .select('id, phone')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function countViolations(admin) {
  const vendors = await fetchAllVendors(admin);
  const { data: users, error: uErr } = await admin.from('users').select('id, phone');
  if (uErr) throw uErr;
  return {
    vendors: vendors.filter((v) => !isAllowedPhone(v.phone)),
    users: (users ?? []).filter((u) => !isAllowedPhone(u.phone)),
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function deleteVendorsFkSafe(admin, vendorRows, log) {
  const vendorIds = vendorRows.map((v) => v.id);
  const vendorPhones = vendorRows.map((v) => v.phone).filter(Boolean);
  if (!vendorIds.length) return { deleted: 0 };

  let deletedTotal = 0;
  const batches = chunk(vendorIds, 40);

  for (const batch of batches) {
    const phonesBatch = vendorRows.filter((v) => batch.includes(v.id)).map((v) => v.phone);

    await admin.from('categories').update({ suggested_by_vendor_id: null }).in('suggested_by_vendor_id', batch);
    await admin.from('app_users').update({ referred_by_vendor_id: null }).in('referred_by_vendor_id', batch);
    await admin.from('feed_replies').update({ suggested_vendor_id: null }).in('suggested_vendor_id', batch);

    await admin.from('vendor_credits').delete().in('vendor_id', batch);
    await admin.from('referrals').delete().in('referrer_vendor_id', batch);
    for (const phone of phonesBatch) {
      if (phone) await admin.from('referrals').delete().eq('referee_id', phone);
    }

    const { data: requestRows, error: reqSelErr } = await admin.from('requests').select('id').in('vendor_id', batch);
    if (reqSelErr) throw new Error(`requests select: ${reqSelErr.message}`);
    const requestIds = requestRows?.map((r) => r.id) ?? [];
    if (requestIds.length) {
      for (const reqChunk of chunk(requestIds, 100)) {
        const { error: oiErr } = await admin.from('order_items').delete().in('request_id', reqChunk);
        if (oiErr) throw new Error(`order_items: ${oiErr.message}`);
      }
    }

    await admin.from('order_bills').delete().in('vendor_id', batch);
    await admin.from('saved_vendors').delete().in('vendor_id', batch);
    await admin.from('vendor_reviews').delete().in('vendor_id', batch);
    await admin.from('khata_transactions').delete().in('vendor_id', batch);
    await admin.from('khata_ledger').delete().in('vendor_id', batch);
    await admin.from('user_flags').delete().in('vendor_id', batch);
    await admin.from('vendor_menu_items').delete().in('vendor_id', batch);

    const { error: reqDelErr } = await admin.from('requests').delete().in('vendor_id', batch);
    if (reqDelErr) throw new Error(`requests delete: ${reqDelErr.message}`);

    const { data: postRows } = await admin.from('feed_posts').select('id').in('vendor_id', batch);
    const postIds = postRows?.map((p) => p.id) ?? [];
    if (postIds.length) {
      for (const postChunk of chunk(postIds, 100)) {
        await admin.from('feed_flags').delete().in('post_id', postChunk);
        await admin.from('feed_replies').delete().in('post_id', postChunk);
      }
    }
    await admin.from('feed_posts').delete().in('vendor_id', batch);

    await admin.from('vendor_categories').delete().in('vendor_id', batch);
    await admin.from('vendor_verification').delete().in('vendor_id', batch);

    const { data: deleted, error } = await admin.from('vendors').delete().in('id', batch).select('id');
    if (error) throw new Error(`vendor delete: ${error.message}`);
    deletedTotal += deleted?.length ?? 0;
    log(`  batch deleted ${deleted?.length ?? 0} vendors (running total ${deletedTotal})`);
  }

  return { deleted: deletedTotal };
}

async function checkUserPhoneData(admin, phone) {
  const tables = [
    'requests',
    'vendor_reviews',
    'saved_vendors',
    'khata_ledger',
    'khata_transactions',
    'user_addresses',
    'user_notifications',
  ];
  const counts = {};
  for (const table of tables) {
    const { count, error } = await admin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_phone', phone);
    if (error) counts[table] = { error: error.message };
    else counts[table] = count ?? 0;
  }
  return counts;
}

async function deletePublicUser(admin, phone) {
  const { data, error } = await admin.from('users').delete().eq('phone', phone).select('id, phone');
  if (error) throw error;
  return data ?? [];
}

async function deleteLegacyAuthUsers(admin, log) {
  const targets = [];
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    if (!data?.users?.length) break;
    for (const user of data.users) {
      const email = user.email ?? '';
      const digits = (user.phone ?? '').replace(/\D/g, '');
      if (email.endsWith('@aaspaas.invalid') && email.startsWith('test+91') && digits.length === 13) {
        targets.push({ id: user.id, email, phone: user.phone, digits });
      }
    }
    if (data.users.length < 200) break;
    page += 1;
  }

  log(`Found ${targets.length} auth.users with 13-digit phone + test+91...@aaspaas.invalid`);
  const deleted = [];
  for (const u of targets) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`deleteUser ${u.id}: ${error.message}`);
    deleted.push(u);
  }
  return deleted;
}

function runValidateConstraints(projectRef) {
  const sql = `ALTER TABLE public.vendors VALIDATE CONSTRAINT vendors_phone_format_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_phone_format_check;`;
  const sqlFile = path.join(projectRoot, 'scripts', '_validate_phone_constraints.sql');
  fs.writeFileSync(sqlFile, sql);
  const link = spawnSync('npx', ['supabase', 'link', '--project-ref', projectRef, '--yes'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: true,
  });
  if (link.status !== 0) {
    throw new Error(`link failed: ${link.stderr || link.stdout}`);
  }
  const query = spawnSync(
    'npx',
    ['supabase', 'db', 'query', '--linked', '-f', sqlFile],
    { cwd: projectRoot, encoding: 'utf8', shell: true },
  );
  return {
    linkStdout: link.stdout,
    queryStdout: query.stdout,
    queryStderr: query.stderr,
    status: query.status,
  };
}

async function runEnv(label) {
  const { url, key, ref } = loadEnv(label);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const log = (msg) => console.log(`[${label.toUpperCase()}] ${msg}`);

  console.log(`\n${'='.repeat(60)}\n${label.toUpperCase()} (${ref})\n${'='.repeat(60)}`);

  // Step 0: baseline
  const before = await countViolations(admin);
  log(`Step 0 baseline — vendor violations: ${before.vendors.length}, user violations: ${before.users.length}`);

  if (label === 'test') {
    // Step 1: delete violating vendors
    log(`Step 1 — deleting ${before.vendors.length} violating vendor rows...`);
    const { deleted } = await deleteVendorsFkSafe(admin, before.vendors, log);
    log(`Step 1 done — deleted ${deleted} vendors`);

    // Step 2: auth.users 13-digit legacy
    log('Step 2 — deleting legacy auth.users (13-digit test phones)...');
    const authDeleted = await deleteLegacyAuthUsers(admin, log);
    log(`Step 2 done — deleted ${authDeleted.length} auth.users`);

    // Step 3: public.users violations
    log('Step 3 — checking public.users violations before delete...');
    for (const u of before.users) {
      const counts = await checkUserPhoneData(admin, u.phone);
      const total = Object.values(counts).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
      log(`  phone ${u.phone} (${u.id}): ${JSON.stringify(counts)} total_related=${total}`);
      if (total > 0) {
        throw new Error(`Refusing to delete public.users ${u.phone} — has related data`);
      }
      const removed = await deletePublicUser(admin, u.phone);
      log(`  deleted public.users rows: ${JSON.stringify(removed)}`);
    }
    log('Step 3 done');
  }

  if (label === 'prod') {
    // Step 4: delete 16 inert vendors (re-fetch violations)
    const prodViolations = await countViolations(admin);
    log(`Step 4 — deleting ${prodViolations.vendors.length} violating vendor rows...`);
    const { deleted } = await deleteVendorsFkSafe(admin, prodViolations.vendors, log);
    log(`Step 4 done — deleted ${deleted} vendors`);
  }

  // Step 5: VALIDATE CONSTRAINT
  log('Step 5 — VALIDATE CONSTRAINT on vendors + users...');
  const validate = runValidateConstraints(ref);
  log(`Step 5 link: ${validate.linkStdout?.trim() || '(ok)'}`);
  log(`Step 5 query status: ${validate.status}`);
  if (validate.queryStdout) log(`Step 5 stdout: ${validate.queryStdout.trim()}`);
  if (validate.queryStderr) log(`Step 5 stderr: ${validate.queryStderr.trim()}`);
  if (validate.status !== 0) throw new Error('VALIDATE CONSTRAINT failed');

  // Step 6: re-query
  const after = await countViolations(admin);
  log(`Step 6 — remaining vendor violations: ${after.vendors.length}`);
  log(`Step 6 — remaining user violations: ${after.users.length}`);
  if (after.vendors.length || after.users.length) {
    log(`Step 6 FAIL sample vendors: ${JSON.stringify(after.vendors.slice(0, 5))}`);
    log(`Step 6 FAIL sample users: ${JSON.stringify(after.users)}`);
    throw new Error('Violations remain after cleanup');
  }
  log('Step 6 — SUCCESS: zero violations on both tables');
}

const mode = process.argv[2] ?? 'both';
if (mode === 'test' || mode === 'both') await runEnv('test');
if (mode === 'prod' || mode === 'both') await runEnv('prod');
