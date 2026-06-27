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

const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type RequestBody = {
  image_base64?: string;
  media_type?: string;
  healthCheck?: boolean;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
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
      console.error("parse-image-order missing ANTHROPIC_API_KEY");
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
        max_tokens: 300,
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
                text:
                  'This is a handwritten or typed order note in Hindi, Marathi, or English. Extract the order items as a clean comma-separated list. Return ONLY the items, no explanation. Example: "2kg atta, 1 Colgate red, 3 Maggi noodles"',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("parse-image-order Anthropic error", response.status, errText);
      return jsonResponse({
        success: false,
        error: "Vision API request failed",
      });
    }

    const data = await response.json();
    const text = extractTextFromAnthropicResponse(data);

    if (!text) {
      return jsonResponse({ success: false, error: "No text extracted from image" });
    }

    return jsonResponse({ success: true, text });
  } catch (err) {
    console.error("parse-image-order failed", err);
    return jsonResponse({ success: false, error: "Internal error" });
  }
});
