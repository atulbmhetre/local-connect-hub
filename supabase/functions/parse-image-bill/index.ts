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

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type BillLineItem = {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

type RequestBody = {
  image_base64?: string;
  media_type?: string;
  healthCheck?: boolean;
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
    p_function_name: "parse-image-bill",
    p_identifier_type: identifierType,
    p_identifier: identifier,
    p_max_requests: maxRequests,
    p_window_seconds: 60,
  });
  if (error) {
    console.error("parse-image-bill rate limit RPC failed", identifierType, error);
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

function extractTextFromAnthropicResponse(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text"
    )
    .map((block) => String((block as { text?: string }).text ?? "").trim())
    .join(" ")
    .trim();
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

    if (body.healthCheck === true) {
      return jsonResponse({ status: "ok" });
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
      console.error("parse-image-bill missing SUPABASE_URL/SERVICE_ROLE_KEY for rate limiting");
    }

    const image_base64 = body.image_base64?.trim();
    const media_type = body.media_type?.trim() || "image/jpeg";

    if (!image_base64) {
      return jsonResponse({ success: false, error: "Missing image_base64" });
    }

    if (!ALLOWED_MEDIA_TYPES.has(media_type)) {
      return jsonResponse({ success: false, error: "Unsupported media_type" });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.error("parse-image-bill missing ANTHROPIC_API_KEY");
      return jsonResponse({ success: false, error: "Server misconfigured" });
    }

    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type,
                  data: image_base64,
                },
              },
              {
                type: "text",
                text: `This is a handwritten or printed bill/receipt from an Indian vendor in Hindi, Marathi, or English.
Extract all line items. Return ONLY valid JSON, no other text:
{
  "items": [
    {
      "description": "item name",
      "quantity": 1,
      "unit": "kg/piece/litre/etc or empty string",
      "unit_price": 0
    }
  ]
}

Rules:
1. Extract every item visible with quantity and price
2. If quantity not clear, use 1
3. Keep description in original language
4. Total/subtotal rows should NOT be included as items`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("parse-image-bill Anthropic error", response.status, errText);
      return jsonResponse({ success: false, error: "Parse failed" });
    }

    const data = await response.json();
    const rawText = extractTextFromAnthropicResponse(data);
    const parsed = extractJson<{ items?: unknown }>(rawText);

    if (!parsed || !Array.isArray(parsed.items)) {
      console.error("parse-image-bill invalid JSON", rawText);
      return jsonResponse({ success: false, error: "Parse failed" });
    }

    const items = normalizeItems(parsed.items);
    if (!items.length) {
      return jsonResponse({ success: false, error: "Parse failed" });
    }

    return jsonResponse({ success: true, items });
  } catch (err) {
    console.error("parse-image-bill failed", err);
    return jsonResponse({ success: false, error: "Internal error" });
  }
});
