import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rpxsyeqskvhjmbkxnpmd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

export type Vendor = {
  id: string;
  name: string;
  shop_name: string;
  category: string;
  upi_id: string;
  is_active: boolean;
  created_at: string;
};

export const CATEGORIES = [
  { id: "tyre", label: "Tyre / Mechanic", emoji: "🛞" },
  { id: "key", label: "Key Maker", emoji: "🔑" },
  { id: "medical", label: "Medical", emoji: "🩺" },
  { id: "electrician", label: "Electrician", emoji: "💡" },
] as const;
