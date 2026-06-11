import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lib/supabase.ts", import.meta.url), "utf8");
const url = src.match(/"(https:\/\/[a-z]+\.supabase\.co)"/)[1];
const key = src.match(/"(eyJ[\w.-]+)"/)[1];
const headers = { apikey: key, Authorization: `Bearer ${key}` };

const postId = "3f399ddf-2e04-4ba9-93e4-e13529e16ed8";
const res = await fetch(
  `${url}/rest/v1/feed_posts?select=id,user_phone,lat,lng,type,content,created_at&id=eq.${postId}`,
  { headers },
);
console.log(await res.json());
