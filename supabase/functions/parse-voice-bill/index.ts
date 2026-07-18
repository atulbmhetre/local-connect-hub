import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clientIp } from "../_shared/rateLimitUtils.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type BillLineItem = {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

type RequestBody = {
  text?: string;
  phone?: string;
  vendor_id?: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  identifierType: "phone" | "ip",
  identifier: string,
  maxRequests: number,
): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("check_and_log_rate_limit", {
    p_function_name: "parse-voice-bill",
    p_identifier_type: identifierType,
    p_identifier: identifier,
    p_max_requests: maxRequests,
    p_window_seconds: 60,
  });
  if (error) {
    console.error("parse-voice-bill rate limit RPC failed", identifierType, error);
    return null; // fail open — never block real billing on infra error
  }
  return data === true;
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

function normalizeItem(raw: unknown): BillLineItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const description = typeof o.description === "string" ? o.description.trim() : "";
  if (!description) return null;
  const quantity =
    typeof o.quantity === "number" && Number.isFinite(o.quantity) && o.quantity > 0
      ? o.quantity
      : 1;
  const unit = typeof o.unit === "string" ? o.unit.trim() : "";
  const unit_price =
    typeof o.unit_price === "number" && Number.isFinite(o.unit_price) && o.unit_price >= 0
      ? o.unit_price
      : 0;
  return { description, quantity, unit, unit_price };
}

function normalizeItems(raw: unknown): BillLineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: BillLineItem[] = [];
  for (const entry of raw) {
    const item = normalizeItem(entry);
    if (item) items.push(item);
  }
  return items;
}

async function callGroq(prompt: string): Promise<string> {
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
      temperature: 0.1,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("parse-voice-bill Groq error", resp.status, errText);
    throw new Error("Groq request failed");
  }

  const data = await resp.json();
  return typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content.trim()
    : "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" });
    }

    // Rate limit before validation/AI: this endpoint is anon-reachable and
    // calls a paid AI API, so it must be metered (phone when supplied + IP).
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const phone = body.phone?.trim() || undefined;

      if (phone) {
        const phoneAllowed = await checkRateLimit(supabase, "phone", phone, 10);
        if (phoneAllowed === false) {
          return jsonResponse({
            success: false,
            error: "Too many requests, please wait a moment and try again.",
          }, 429);
        }
      }

      const ipAllowed = await checkRateLimit(supabase, "ip", clientIp(req), 20);
      if (ipAllowed === false) {
        return jsonResponse({
          success: false,
          error: "Too many requests, please wait a moment and try again.",
        }, 429);
      }
    } else {
      console.error("parse-voice-bill missing SUPABASE_URL/SERVICE_ROLE_KEY for rate limiting");
    }

    const text = body.text?.trim();
    if (!text) {
      return jsonResponse({ success: false, error: "Missing text" });
    }

    const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const prompt = `You are a bill parser for an Indian vendor app.
The vendor spoke this bill aloud: "${escapedText}"

Parse it into line items. Return ONLY valid JSON, no other text:
{
  "items": [
    {
      "description": "item name in original language",
      "quantity": 1,
      "unit": "kg/piece/litre/etc or empty string",
      "unit_price": 0
    }
  ]
}

Rules:
1. Extract every item with its quantity and price
2. If quantity not mentioned, use 1
3. If unit not mentioned, use empty string
4. If price not mentioned, use 0
5. Keep description in original language (Hindi/Marathi/English)
6. NEVER add items not mentioned

Examples:
"2kg onion 40 rupees, 1L milk 28" → [{description:"onion", quantity:2, unit:"kg", unit_price:20}, {description:"milk", quantity:1, unit:"L", unit_price:28}]
"teen Colgate lao pachas rupay ka" → [{description:"Colgate", quantity:3, unit:"", unit_price:16.67}]`;

    let rawText: string;
    try {
      rawText = await callGroq(prompt);
    } catch (err) {
      console.error("parse-voice-bill Groq call failed", err);
      return jsonResponse({ success: false, error: "Parse failed" });
    }

    const parsed = extractJson<{ items?: unknown }>(rawText);
    if (!parsed || !Array.isArray(parsed.items)) {
      console.error("parse-voice-bill invalid JSON", rawText);
      return jsonResponse({ success: false, error: "Parse failed" });
    }

    const items = normalizeItems(parsed.items);
    if (!items.length) {
      return jsonResponse({ success: false, error: "Parse failed" });
    }

    return jsonResponse({ success: true, items });
  } catch (err) {
    console.error("parse-voice-bill failed", err);
    return jsonResponse({ success: false, error: "Internal error" });
  }
});
