/**
 * Fail if any tracked .ts / .tsx file is empty (0 bytes) on disk.
 * Guards against truncate-on-write corruption during agent edits.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

const empty = [];

for (const file of files) {
  try {
    if (statSync(file).size === 0) {
      empty.push(file);
    }
  } catch {
    // File listed in git but missing on disk — git will catch this elsewhere.
  }
}

if (empty.length > 0) {
  console.error('ERROR: tracked TypeScript files are empty (0 bytes) on disk:');
  for (const file of empty) {
    console.error(`  EMPTY: ${file}`);
  }
  console.error(
    'Restore from git HEAD, e.g. git checkout HEAD -- <path>',
  );
  process.exit(1);
}

console.log(`check-empty-tracked-ts: OK (${files.length} tracked .ts/.tsx files)`);
