import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

export const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_ANON_KEY!
);

export const CONFIG = {
  adminPhone: '8888169446',
  vendorPhone: '9096082707',
  customerPhone: '9999999999',
  appUrl: process.env.VITE_APP_URL || 'http://localhost:8080',
  sessionId: `test_${Date.now()}`,
};
