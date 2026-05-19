import "@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type GatewayAction = "classify_category" | "ai_bridge_brief" | "transcribe_parchi";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: CORS_HEADERS });
}

function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

async function callGroq(system: string, user: string, temperature = 0.2) {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("Missing GROQ_API_KEY");

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text =
    typeof data?.choices?.[0]?.message?.content === "string"
      ? data.choices[0].message.content.trim()
      : "";

  return { data, text };
}

/** Only these labels may be returned to clients; Groq output is validated against this list. */
const ALLOWED_CATEGORIES = [
  "Mechanic",
  "Towing",
  "Tyre Service",
  "Key Maker",
  "Ambulance",
  "Nursing",
  "Plumber",
  "Electrician",
  "Security",
  "Pharmacy",
  "Grocery Store",
  "Medicine Delivery",
  "Beautician",
  "Fire Brigade",
] as const;

type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];

const CATEGORY_META: Record<
  AllowedCategory,
  { mode: "help" | "delivery"; emoji: string; hindi: string }
> = {
  Mechanic: { mode: "help", emoji: "🔧", hindi: "मैकेनिक" },
  Towing: { mode: "help", emoji: "🚛", hindi: "टोइंग" },
  "Tyre Service": { mode: "help", emoji: "🛞", hindi: "टायर सर्विस" },
  "Key Maker": { mode: "help", emoji: "🔑", hindi: "चाबी बनाने वाला" },
  Ambulance: { mode: "help", emoji: "🚑", hindi: "एंबुलेंस" },
  Nursing: { mode: "help", emoji: "🩺", hindi: "नर्सिंग" },
  Plumber: { mode: "help", emoji: "🚰", hindi: "प्लम्बर" },
  Electrician: { mode: "help", emoji: "💡", hindi: "इलेक्ट्रीशियन" },
  Security: { mode: "help", emoji: "🛡️", hindi: "सिक्योरिटी" },
  Pharmacy: { mode: "delivery", emoji: "💊", hindi: "फार्मेसी" },
  "Grocery Store": { mode: "delivery", emoji: "🏪", hindi: "किराना स्टोर" },
  "Medicine Delivery": { mode: "delivery", emoji: "💊", hindi: "दवाई डिलीवरी" },
  Beautician: { mode: "help", emoji: "💄", hindi: "ब्यूटीशियन" },
  "Fire Brigade": { mode: "help", emoji: "🔥", hindi: "फायर ब्रिगेड" },
};

function normalizeAllowedCanonical(raw: string): AllowedCategory | null {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const lower = t.toLowerCase();
  for (const c of ALLOWED_CATEGORIES) {
    if (c.toLowerCase() === lower) return c;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const action = body?.action as GatewayAction | undefined;

    if (!action) {
      return jsonResponse({ error: "Missing action" }, 400);
    }

    if (action === "classify_category") {
      const input = String(body?.term ?? body?.input ?? "").trim();
      if (!input) return jsonResponse({ error: "Missing input" }, 400);

      const lower = input.toLowerCase();
      if (/\bhospitals?\b/.test(lower)) {
        return jsonResponse({
          action,
          result: {
            canonical: null,
            message: "Search for Ambulance, Doctor, or Nursing instead",
          },
        });
      }

      if (
        /\b(fire station|fire brigade|agni\s*shaman|agnishaman)\b/i.test(input)
      ) {
        return jsonResponse({
          action,
          result: {
            canonical: "Fire Brigade",
            is_government: true,
            mode: "help",
            emoji: "🔥",
            hindi: "फायर ब्रिगेड",
          },
        });
      }

      // Wellness / beauty — conservative alias map (same as client KNOWN_CATEGORIES)
      const beauticianWellness =
        /\b(therapist|therapy|massage|spa|salon|parlou?r|beauty\s*parlou?r|beautician|mehendi|makeup\s*artist|nail\s*art|facial|waxing)\b/i;
      if (beauticianWellness.test(input)) {
        const meta = CATEGORY_META.Beautician;
        return jsonResponse({
          action,
          result: {
            canonical: "Beautician",
            mode: meta.mode,
            emoji: meta.emoji,
            hindi: meta.hindi,
          },
        });
      }

      const system = `You are a category classifier for a hyperlocal service app in India.
Your job is to match user search terms to ONLY these exact categories:

Mechanic, Towing, Tyre Service, Key Maker, Ambulance, Nursing, 
Plumber, Electrician, Security, Pharmacy, Grocery Store, 
Medicine Delivery, Beautician, Fire Brigade

STRICT RULES:
1. Only return a category from the list above — nothing else
2. If the term does not clearly match any category, return null
3. Do NOT guess or approximate — wrong answer is worse than null
4. Aliases allowed: common misspellings, Hindi/Marathi words, 
   slang for the SAME service
5. If confidence is below 80%, return null

Examples of CORRECT matches:
- 'mikanik' → Mechanic
- 'bijli' → Electrician  
- 'butishin' → Beautician
- 'dawai' → Pharmacy
- 'puncture' → Tyre Service

Examples of what to return null for:
- 'hospital' → null (not a vendor category)
- 'food' → null (not in our categories)
- 'cobbler' → null (not in our categories)

Return JSON only: { "canonical": string | null }`;

      const { text } = await callGroq(system, input, 0.08);
      const parsed = extractJson<{ canonical?: string | null }>(text);

      let resolved: AllowedCategory | null = null;
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, "canonical")) {
        const c = parsed.canonical;
        if (c === null) {
          resolved = null;
        } else if (typeof c === "string") {
          resolved = normalizeAllowedCanonical(c);
        }
      }

      if (resolved === null) {
        return jsonResponse(
          {
            action,
            result: { canonical: null },
            raw: text,
          },
          200,
        );
      }

      const meta = CATEGORY_META[resolved];
      return jsonResponse({
        action,
        result: {
          canonical: resolved,
          mode: meta.mode,
          emoji: meta.emoji,
          hindi: meta.hindi,
        },
      });
    }

    if (action === "ai_bridge_brief") {
      const userNeed = String(body?.user_need ?? "").trim();
      if (!userNeed) {
        return jsonResponse({ error: "Missing user_need" }, 400);
      }

      let vendorName = String(body?.vendor_name ?? "").trim();
      let shopName = String(body?.shop_name ?? "").trim();
      let category = String(body?.category ?? "").trim();
      let distanceKm: number | null = null;
      const rawDist = body?.distance_km;
      if (rawDist !== null && rawDist !== undefined && rawDist !== "") {
        const n = typeof rawDist === "number" ? rawDist : parseFloat(String(rawDist));
        if (Number.isFinite(n)) distanceKm = n;
      }

      const legacyVendor = body?.vendor;
      if (legacyVendor && typeof legacyVendor === "object") {
        const v = legacyVendor as Record<string, unknown>;
        if (!vendorName) vendorName = String(v.name ?? "").trim();
        if (!shopName) shopName = String(v.shop_name ?? v.shopName ?? "").trim();
        if (!category) category = String(v.category ?? "").trim();
        if (distanceKm == null && v.distance_km != null) {
          const n = Number(v.distance_km);
          if (Number.isFinite(n)) distanceKm = n;
        }
      }

      const displayVendor = vendorName || shopName || "Vendor";
      const displayCategory = category || "service";
      const distancePhrase =
        distanceKm != null && Number.isFinite(distanceKm)
          ? distanceKm < 1
            ? `${Math.round(distanceKm * 1000)} meters`
            : `${distanceKm.toFixed(1)} km`
          : "nearby";

      const system = `You are sending a quick alert to a local vendor in India.
Write exactly 2 short sentences in English only. No Hindi. No Hinglish.
Adjust tone based on category:

- Ambulance, Nursing, Medical:
  Urgent and serious.
  Example: 'Urgent: A patient needs immediate help 2km away.
  Please respond immediately.'

- Mechanic, Towing, Tyre Service, Key Maker:
  Casual and friendly.
  Example: 'Vijay, there is a customer 4.9km away who needs towing.
  Are you available right now?'

- Plumber, Electrician, Security:
  Friendly but professional.
  Example: 'Hi Santosh, a customer 3km away needs plumbing help.
  Can you take it?'

- Grocery Store, Pharmacy, Medicine Delivery:
  Warm, neighbourhood feel.
  Example: 'Rajesh, a nearby customer needs medicines from your shop.
  Can you deliver today?'

Always include vendor first name and distance.
Never use Hindi words. English only.

Return ONLY JSON: {"brief":"..."} with those two sentences in brief. No markdown, no nested quotes inside the brief text.`;

      const userMsg =
        `Vendor: ${displayVendor}, Category: ${displayCategory}. ` +
        `Shop: ${shopName || "—"}. ` +
        `A user ${distancePhrase} away needs help with: ${userNeed}. ` +
        `Write the 2-sentence brief for this vendor (use their first name from "${displayVendor}" if clear).`;

      const { text } = await callGroq(system, userMsg);
      const parsed = extractJson<{ brief?: string }>(text);

      return jsonResponse({
        action,
        result: {
          brief:
            parsed?.brief ??
            `${displayVendor}, a user nearby needs ${displayCategory} help (${userNeed}). ` +
              `They are ${distancePhrase}. Please confirm availability and exact location.`,
        },
      });
    }

    if (action === "transcribe_parchi") {
      const input = String(body?.input ?? "").trim();
      if (!input) return jsonResponse({ error: "Missing input" }, 400);

      const system =
        "You clean and structure Indian grocery or service 'parchi' text. Return ONLY JSON with: list_type (grocery|service|mixed), cleaned_text, items (array of strings).";
      const { text } = await callGroq(system, input);
      const parsed = extractJson<{
        list_type?: "grocery" | "service" | "mixed";
        cleaned_text?: string;
        items?: string[];
      }>(text);

      return jsonResponse({
        action,
        result: {
          list_type: parsed?.list_type ?? "mixed",
          cleaned_text: parsed?.cleaned_text ?? input,
          items: Array.isArray(parsed?.items) ? parsed!.items : [],
        },
      });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected server error" },
      500,
    );
  }
});
