import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (process.platform === 'win32' && nodeMajor >= 23) {
    console.warn(
      `[playwright] Node ${process.versions.node} on Windows can abort mid-suite with ` +
        'libuv UV_HANDLE_CLOSING (nodejs/node#56645). Prefer Node 22 LTS for long runs. ' +
        'Workers are pinned to 1; NO_UPDATE_NOTIFIER=1 is set in playwright.config.ts.',
    );
  }
  execFileSync('node', ['scripts/check-empty-tracked-ts.mjs'], {
    cwd: root,
    stdio: 'inherit',
  });
}
