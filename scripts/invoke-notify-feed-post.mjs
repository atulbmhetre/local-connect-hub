import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lib/supabase.ts", import.meta.url), "utf8");
const url = src.match(/"(https:\/\/[a-z]+\.supabase\.co)"/)[1];
const key = src.match(/"(eyJ[\w.-]+)"/)[1];

const body = {
  post_id: "3f399ddf-2e04-4ba9-93e4-e13529e16ed8",
  post_type: "announcement",
  title: "📢 Announcement near you",
  body: "2nd reminder - No water from 15 June",
  lat: 18.4875129133718,
  lng: 73.7934989253665,
  author_phone: "+91 9096082707",
};

const res = await fetch(`${url}/functions/v1/notify-feed-post`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    apikey: key,
  },
  body: JSON.stringify(body),
});

console.log("status:", res.status);
console.log("headers:", Object.fromEntries(res.headers.entries()));
const text = await res.text();
try {
  console.log("body:", JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log("body:", text);
}
