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
 * PROD verification for admin-gated Settings phone override (DEV-PHONE-01/02).
 * Production Vite build + PROD Supabase (.env.test.prod).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'browser-dev-phone-admin-gate.spec.ts',
  timeout: 90000,
  workers: 1,
  retries: 0,
  use: {
    viewport: { width: 390, height: 844 },
    baseURL: previewUrl,
    headless: true,
  },
  reporter: [['list']],
  webServer: {
    command: 'npx dotenv -e .env.build-test -o -- npm run build:prod && npx vite preview --port 4173 --host 127.0.0.1',
    url: previewUrl,
    reuseExistingServer: process.env.PW_REUSE_PROD_PREVIEW === 'true',
    timeout: 300000,
  },
});
