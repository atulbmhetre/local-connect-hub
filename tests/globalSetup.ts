import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  execFileSync('node', ['scripts/check-empty-tracked-ts.mjs'], {
    cwd: root,
    stdio: 'inherit',
  });
}
