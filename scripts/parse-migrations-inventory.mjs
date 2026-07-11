/**
 * Parse supabase/migrations for BACKEND_INVENTORY.md generation.
 * Output: scripts/_backend_inventory_data.json
 */
import fs from 'node:fs';
import path from 'node:path';

const migDir = path.resolve('supabase/migrations');
const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();

const functions = new Map();
const policies = new Map(); // table -> Map(name -> policy)
const indexes = new Map(); // table -> Map(name -> cols)
const tables = new Set();
const rlsEnabled = new Map(); // table -> bool

function splitParams(paramStr) {
  if (!paramStr.trim()) return [];
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of paramStr) {
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map((p) => {
    const m = p.match(/^(?:(?:IN|OUT|INOUT)\s+)?(\w+)\s+([\w\[\]\.]+(?:\s*\[\])?)/i);
    return m ? { name: m[1], type: m[2] } : { raw: p };
  });
}

function extractTablesFromBody(body) {
  const reads = new Set();
  const writes = new Set();
  const patterns = [
    [/FROM\s+public\.(\w+)/gi, 'read'],
    [/JOIN\s+public\.(\w+)/gi, 'read'],
    [/INTO\s+public\.(\w+)/gi, 'write'],
    [/UPDATE\s+public\.(\w+)/gi, 'write'],
    [/DELETE\s+FROM\s+public\.(\w+)/gi, 'write'],
  ];
  for (const [re, kind] of patterns) {
    let m;
    while ((m = re.exec(body))) {
      if (kind === 'read') reads.add(m[1]);
      else writes.add(m[1]);
    }
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

function extractIdentityChecks(body) {
  const checks = [];
  const patterns = [
    /auth_user_phone\(\)/g,
    /auth\.uid\(\)/g,
    /p_vendor_phone/g,
    /p_user_phone/g,
    /p_phone/g,
    /p_device_id/g,
    /_vendor_owns_request/g,
    /_is_admin/g,
    /admin_/g,
  ];
  for (const re of patterns) {
    if (re.test(body)) checks.push(re.source);
  }
  const whereLines = body.match(/WHERE[\s\S]{0,300}/gi) || [];
  return { checks: [...new Set(checks)], whereSamples: whereLines.slice(0, 5) };
}

for (const file of files) {
  const sql = fs.readFileSync(path.join(migDir, file), 'utf8');

  for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)/gi)) {
    tables.add(m[1]);
  }

  for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\s+(ENABLE|DISABLE) ROW LEVEL SECURITY/gi)) {
    rlsEnabled.set(m[1], m[2].toUpperCase() === 'ENABLE');
  }

  for (const m of sql.matchAll(/DROP POLICY IF EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)/gi)) {
    const t = m[2];
    if (policies.has(t)) policies.get(t).delete(m[1]);
  }

  const policyRe = /CREATE POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)/gi;
  let pm;
  while ((pm = policyRe.exec(sql)) !== null) {
    const name = pm[1];
    const table = pm[2];
    const start = pm.index;
    const semi = sql.indexOf(';', start);
    const block = sql.slice(start, semi);
    const cmdM = block.match(/FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)/i);
    const usingM = block.match(/USING\s*\(([\s\S]*?)\)\s*(?:WITH CHECK|TO|;)/i);
    const checkM = block.match(/WITH CHECK\s*\(([\s\S]*?)\)\s*(?:TO|;)/i);
    if (!policies.has(table)) policies.set(table, new Map());
    policies.get(table).set(name, {
      cmd: cmdM ? cmdM[1].toUpperCase() : 'ALL',
      using: usingM?.[1]?.trim().replace(/\s+/g, ' ') ?? null,
      with_check: checkM?.[1]?.trim().replace(/\s+/g, ' ') ?? null,
      file,
    });
  }

  for (const m of sql.matchAll(/CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)?\s+(\w+)\s+ON\s+(?:public\.)?(\w+)\s*(\([^;]+\))/gi)) {
    const table = m[2];
    if (!indexes.has(table)) indexes.set(table, new Map());
    indexes.get(table).set(m[1], m[3].trim().replace(/\s+/g, ' '));
  }
  for (const m of sql.matchAll(/DROP INDEX(?: IF EXISTS)?\s+(?:public\.)?(\w+)/gi)) {
    for (const [, idxs] of indexes) idxs.delete(m[1]);
  }

  const fnRe = /CREATE OR REPLACE FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*([\s\S]*?)\nAS\s*\$\$/gi;
  let fm;
  while ((fm = fnRe.exec(sql)) !== null) {
    const name = fm[1];
    const params = splitParams(fm[2]);
    const header = fm[3];
    const bodyStart = fm.index + fm[0].length;
    const bodyEnd = sql.indexOf('\n$$;', bodyStart);
    const body = bodyEnd > bodyStart ? sql.slice(bodyStart, bodyEnd) : '';
    const secDef = /SECURITY DEFINER/i.test(header);
    const searchPath = header.match(/SET\s+search_path\s*=\s*(\w+)/i)?.[1] ?? null;
    const stable = /STABLE/i.test(header);
    const lang = header.match(/LANGUAGE\s+(\w+)/i)?.[1] ?? 'plpgsql';

    const slice = sql.slice(fm.index, fm.index + 8000);
    const revoke = /REVOKE ALL ON FUNCTION public\.\w+/i.test(slice);
    const grantAnon = /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+anon/i.test(slice);
    const grantAuth = /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+authenticated/i.test(slice);
    const grantService = /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+service_role/i.test(slice);

    const { reads, writes } = extractTablesFromBody(body);
    const identity = extractIdentityChecks(body);
    const hasForUpdate = /FOR UPDATE/i.test(body);
    const multiWrite = writes.length > 1 || (writes.length === 1 && reads.length > 0);

    functions.set(name, {
      file,
      params,
      lang,
      secDef,
      searchPath,
      stable,
      revoke,
      grantAnon,
      grantAuth,
      grantService,
      reads,
      writes,
      identity,
      hasForUpdate,
      multiWrite,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 1200),
    });
  }
}

const out = {
  migrationFiles: files.length,
  migrationFileList: files,
  functionCount: functions.size,
  functions: Object.fromEntries(functions),
  tableCount: tables.size,
  tables: [...tables].sort(),
  rlsEnabled: Object.fromEntries(rlsEnabled),
  policyTableCount: policies.size,
  policies: Object.fromEntries(
    [...policies.entries()].map(([t, m]) => [t, Object.fromEntries(m)]),
  ),
  indexTableCount: indexes.size,
  indexes: Object.fromEntries(
    [...indexes.entries()].map(([t, m]) => [t, Object.fromEntries(m)]),
  ),
};

fs.writeFileSync('scripts/_backend_inventory_data.json', JSON.stringify(out, null, 2));
console.log(
  `Parsed ${files.length} migrations: ${functions.size} functions, ${policies.size} policy tables, ${indexes.size} index tables`,
);
