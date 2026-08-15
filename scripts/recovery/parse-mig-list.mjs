import { readFileSync } from 'node:fs';

function parse(path, label) {
  const raw = readFileSync(path, 'utf8');
  const i = raw.lastIndexOf('{"migrations"');
  if (i < 0) throw new Error(`no JSON in ${path}`);
  const { migrations } = JSON.parse(raw.slice(i));
  const pending = migrations.filter((x) => !x.remote);
  const aug15 = migrations.filter((x) => x.local.startsWith('202608151'));
  console.log(`\n=== ${label} ===`);
  console.log('pending:', pending.length ? pending.map((x) => x.local).join(', ') : 'none');
  for (const x of aug15) {
    console.log(`  ${x.local}  local=${x.local} remote=${x.remote || '(empty)'}`);
  }
  const target = migrations.find((x) => x.local === '20260815180001');
  console.log(
    `20260815180001 synced:`,
    target?.local === target?.remote ? 'yes' : 'no',
  );
}

parse('.mig-prod.json', 'PROD rpxsyeqskvhjmbkxnpmd');
parse('.mig-test.json', 'TEST hhdylnhqdzfabsolwxdz');
