import "@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type GatewayAction = "classify_category";

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

      const VALID_CATEGORIES = new Set([
        "Mechanic",
        "Towing",
        "Tyre Service",
        "Key Maker",
        "Ambulance",
        "Pharmacy",
        "Nursing",
        "Plumber",
        "Electrician",
        "Security",
        "Tailor",
        "Beautician",
        "Cook",
        "Barber",
        "Therapist",
        "Grocery Store",
        "Other",
      ]);

      const classifyFallback = {
        canonical: "Other",
        emoji: "✨",
        hindi: "अन्य",
        mode: "help" as const,
      };

      const escapedInput = input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const system = `You are a strict category classifier for a hyperlocal service app in India called Aaspaas.

User input: "${escapedInput}"

You must classify this into ONE of these exact canonical categories:
Mechanic, Towing, Tyre Service, Key Maker, Ambulance, Pharmacy, Nursing, Plumber, Electrician, Security, Tailor, Beautician, Cook, Barber, Therapist, Grocery Store, Other

Rules:
1. Return ONLY valid JSON, no other text
2. If input matches a category above → return that exact label
3. If input is a government service (fire brigade, police, hospital) → return is_government: true with a helpful message
4. If input is completely unrelated to local services → return canonical: "Other"
5. NEVER invent category names not in the list above

Response format:
{
  "canonical": "exact category name from list above OR null if government",
  "emoji": "single emoji",
  "hindi": "Hindi name",
  "is_government": false,
  "message": "only if is_government is true"
}`;

      try {
        const { text } = await callGroq(system, input, 0.08);
        const parsed = extractJson<{
          canonical?: string | null;
          emoji?: string;
          hindi?: string;
          is_government?: boolean;
          message?: string;
        }>(text);

        if (!parsed || typeof parsed !== "object") {
          return jsonResponse({ action, result: classifyFallback });
        }

        const result = { ...parsed };

        if (result.is_government === true) {
          const message =
            typeof result.message === "string" && result.message.trim()
              ? result.message.trim()
              : "This is a government or emergency service — use official helplines.";
          return jsonResponse({
            action,
            result: {
              canonical: null,
              is_government: true,
              message,
            },
          });
        }

        if (result.canonical === null) {
          return jsonResponse(
            {
              action,
              result: { canonical: null },
              raw: text,
            },
            200,
          );
        }

        if (typeof result.canonical !== "string" || !result.canonical.trim()) {
          return jsonResponse({ action, result: classifyFallback });
        }

        let canonical = result.canonical.trim();
        if (!VALID_CATEGORIES.has(canonical)) {
          const matched = [...VALID_CATEGORIES].find(
            (c) => c.toLowerCase() === canonical.toLowerCase(),
          );
          canonical = matched ?? "Other";
        }
        if (!VALID_CATEGORIES.has(canonical)) {
          canonical = "Other";
        }

        if (canonical === "Other") {
          return jsonResponse({
            action,
            result: {
              canonical: "Other",
              emoji:
                typeof result.emoji === "string" && result.emoji.trim()
                  ? result.emoji.trim()
                  : classifyFallback.emoji,
              hindi:
                typeof result.hindi === "string" && result.hindi.trim()
                  ? result.hindi.trim()
                  : classifyFallback.hindi,
              mode: classifyFallback.mode,
            },
          });
        }

        const resolved = normalizeAllowedCanonical(canonical);
        if (resolved) {
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

        return jsonResponse({
          action,
          result: {
            canonical,
            mode: "help",
            emoji:
              typeof result.emoji === "string" && result.emoji.trim()
                ? result.emoji.trim()
                : "✨",
            hindi:
              typeof result.hindi === "string" && result.hindi.trim()
                ? result.hindi.trim()
                : "अन्य",
          },
        });
      } catch {
        return jsonResponse({ action, result: classifyFallback });
      }
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected server error" },
      500,
    );
  }
});
