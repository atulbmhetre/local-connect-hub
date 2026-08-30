/**
 * TEMPORARY re-reason probe: urgent/scheduled mode only (no reach).
 * Delete after review report.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

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

const SYSTEM = `You choose the DEFAULT catalog service_mode for Aaspaas categories.

Modes (exactly one):
- help — customer typically expects same-day / urgent / on-demand fulfillment ("I need this today / now")
- appointment — customer typically expects to book a time / schedule in advance (planned work)
- delivery — goods brought to the customer (not used in this batch unless clearly goods-primary)

CRITICAL — do NOT use travel/reach as a signal:
- Whether the vendor goes to the customer OR the customer comes to a shop is a SEPARATE axis already handled by registration "reach".
- A painter or carpenter traveling to a home is STILL usually scheduled work → appointment, not help.
- "Goes to customer" must NEVER be treated as evidence for help.

ONLY ask: If a real customer needed this trade today, would they typically expect it done same-day/urgently, or would they typically expect to book a time?

Examples of correct thinking:
- Ambulance, Towing, many lockouts → help (urgent expectation)
- Barber, Tutor, Painter (planned job), Carpenter (planned job) → appointment
- Pharmacy, Dairy → delivery

Return ONLY JSON:
{
  "items": [
    {
      "label": "<exact>",
      "current_mode": "<help|delivery|appointment>",
      "proposed_mode": "<help|delivery|appointment>",
      "change": true/false,
      "reasoning": "one sentence answering ONLY urgent-vs-scheduled (do not mention travel/reach)"
    }
  ]
}`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: { categories?: Array<{ label: string; service_mode: string }> } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const categories = body.categories;
  if (!Array.isArray(categories) || !categories.length) {
    return jsonResponse({ error: "Missing categories[]" }, 400);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonResponse({ error: "Missing ANTHROPIC_API_KEY" }, 500);

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2500,
        temperature: 0.1,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ categories }, null, 2) }],
      }),
    });
    if (!resp.ok) {
      return jsonResponse({ error: `Anthropic ${resp.status}`, detail: (await resp.text()).slice(0, 800) }, 502);
    }
    const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    const parsed = extractJson<{ items?: unknown }>(text);
    return jsonResponse({ model: ANTHROPIC_MODEL, raw_text: text, items: Array.isArray(parsed?.items) ? parsed!.items : [] });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
