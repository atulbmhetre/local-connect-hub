import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: "New category suggested" must go through notify-admin once
 * (inbox + FCM). A separate notifyAdminInbox insert causes duplicate inbox rows.
 */
describe('suggest-category admin notify', () => {
  it('uses a single notify-admin invoke; no parallel inbox insert helper', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'supabase/functions/suggest-category/index.ts'),
      'utf8',
    );
    expect(src).toContain('New category suggested');
    expect(src).toMatch(/await notifyAdmin\(\s*supabaseUrl,\s*serviceRoleKey,\s*adminTitle,\s*adminBody\s*\)/);
    expect(src).not.toContain('notifyAdminInbox');
    expect(src).not.toMatch(/await notifyAdmin\([\s\S]*?await notifyAdmin/);
  });
});
