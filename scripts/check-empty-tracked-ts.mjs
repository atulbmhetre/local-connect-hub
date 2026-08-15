/**
 * Fail if any tracked or staged .ts / .tsx / .mjs file is empty (0 bytes).
 * Guards against truncate-on-write corruption during agent edits.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs']);

function gitLines(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

const tracked = gitLines(['ls-files', '--', '*.ts', '*.tsx', '*.mjs']);
const staged = gitLines([
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
]);

const files = [...new Set([...tracked, ...staged].filter(isSourceFile))];

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
  console.error('ERROR: source files are empty (0 bytes) on disk:');
  for (const file of empty) {
    console.error(`  EMPTY: ${file}`);
  }
  console.error(
    'Restore from git HEAD, e.g. git checkout HEAD -- <path>',
  );
  process.exit(1);
}

console.log(
  `check-empty-tracked-ts: OK (${files.length} tracked/staged .ts/.tsx/.mjs files)`,
);
