import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(projectRoot, '.env.test.prod'), override: true });
const previewUrl = 'http://127.0.0.1:4173';
process.env.PW_APP_URL = previewUrl;
process.env.VITE_APP_URL = previewUrl;

/**
 * PROD FirstOpen banned-customer restore (FO-REQ-02b) against production build.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'browser-firstopen-requirements.spec.ts',
  grep: /FO-REQ-02b/,
  timeout: 120000,
  workers: 1,
  retries: 0,
  use: {
    viewport: { width: 390, height: 844 },
    baseURL: previewUrl,
    headless: true,
  },
  reporter: [['list']],
  webServer: {
    command: 'npx dotenv -e .env.build-test -o -- vite build --mode production && npx vite preview --port 4173 --host 127.0.0.1',
    url: previewUrl,
    reuseExistingServer: process.env.PW_REUSE_PROD_PREVIEW === 'true',
    timeout: 300000,
  },
});
