import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

type RequestBody = {
  label?: string;
  vendor_id?: string;
};

type AiResult = {
  emoji: string;
  service_mode: "help" | "delivery" | "appointment";
  hindi: string;
  marathi: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
};

const SERVICE_MODES = new Set(["help", "delivery", "appointment"]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function toTitleCase(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) =>
      word.length === 0
        ? ""
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
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

function buildClassifierPrompt(label: string): string {
  return `You are a category classifier for a hyperlocal service app in India.
A vendor has registered with this service category: "${label}"

Generate the following in JSON format only, no other text:
{
  "emoji": "single most relevant emoji",
  "service_mode": "help" | "delivery" | "appointment",
  "hindi": "Hindi translation of the category name",
  "marathi": "Marathi translation of the category name",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one line explanation of service_mode choice"
}

Rules for service_mode:
- "help": vendor comes to customer immediately/emergency (mechanic, plumber, electrician)
- "delivery": vendor delivers goods to customer (grocery, pharmacy, food)
- "appointment": scheduled service, customer visits vendor or vendor visits on schedule (barber, beautician, tailor, cook)`;
}

function normalizeAiResult(raw: AiResult | null): AiResult | null {
  if (!raw) return null;
  const service_mode = raw.service_mode;
  const confidence = raw.confidence;
  if (!SERVICE_MODES.has(service_mode)) return null;
  if (!CONFIDENCE_LEVELS.has(confidence)) return null;
  if (!raw.emoji?.trim() || !raw.hindi?.trim() || !raw.marathi?.trim()) {
    return null;
  }
  return {
    emoji: raw.emoji.trim(),
    service_mode,
    hindi: raw.hindi.trim(),
    marathi: raw.marathi.trim(),
    confidence,
    reasoning: String(raw.reasoning ?? "").trim(),
  };
}

async function findExistingCategory(
  supabase: ReturnType<typeof createClient>,
  label: string,
): Promise<{ id: string; label: string } | null> {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("categories")
    .select("id, label");

  if (error) {
    console.error("process-new-category categories lookup failed", error);
    throw new Error("Database error");
  }

  const row = (data ?? []).find(
    (c) => c.label?.trim().toLowerCase() === normalized,
  );
  return row ? { id: row.id, label: row.label } : null;
}

async function callAnthropic(label: string): Promise<AiResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: buildClassifierPrompt(label) }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("process-new-category Anthropic error", resp.status, errText);
    throw new Error("AI classification failed");
  }

  const data = await resp.json();
  const textBlocks = data?.content;
  const text =
    Array.isArray(textBlocks)
      ? textBlocks
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b.text ?? "")
        .join("")
        .trim()
      : "";

  const parsed = normalizeAiResult(extractJson<AiResult>(text));
  if (!parsed) {
    console.error("process-new-category invalid AI JSON", text);
    throw new Error("Invalid AI response");
  }

  return parsed;
}

async function notifyAdmin(
  supabaseUrl: string,
  serviceRoleKey: string,
  title: string,
  body: string,
  fcmToken: string,
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/notify-user`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fcm_token: fcmToken, title, body }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("process-new-category notify-user failed", res.status, errText);
    }
  } catch (err) {
    console.error("process-new-category notify-user invoke failed", err);
  }
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

    const label = body.label?.trim();
    const vendor_id = body.vendor_id?.trim();

    if (!label || !vendor_id) {
      return jsonResponse({
        success: false,
        error: "Missing label or vendor_id",
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("process-new-category missing Supabase env");
      return jsonResponse({ success: false, error: "Server misconfigured" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const titleLabel = toTitleCase(label);

    const existing = await findExistingCategory(supabase, label);
    if (existing) {
      return jsonResponse({
        exists: true,
        category_id: existing.id,
      });
    }

    let ai_result: AiResult;
    try {
      ai_result = await callAnthropic(label);
    } catch (err) {
      console.error("process-new-category AI step failed", err);
      return jsonResponse({
        success: false,
        error: err instanceof Error ? err.message : "AI classification failed",
      });
    }

    const { data: newCategory, error: insertError } = await supabase
      .from("categories")
      .insert({
        label: titleLabel,
        emoji: ai_result.emoji,
        service_mode: ai_result.service_mode,
        is_active: false,
        pending_review: true,
        sort_order: 99,
        suggested_by_vendor_id: vendor_id,
        ai_confidence: ai_result.confidence,
      })
      .select("id")
      .single();

    if (insertError || !newCategory) {
      console.error("process-new-category category insert failed", insertError);
      if (insertError?.code === "23505") {
        const again = await findExistingCategory(supabase, label);
        if (again) {
          return jsonResponse({
            exists: true,
            category_id: again.id,
          });
        }
      }
      return jsonResponse({
        success: false,
        error: "Failed to create category",
      });
    }

    const category_id = newCategory.id;

    const { error: translationsError } = await supabase
      .from("category_translations")
      .insert([
        { category_id, lang: "hi", label: ai_result.hindi },
        { category_id, lang: "mr", label: ai_result.marathi },
      ]);

    if (translationsError) {
      console.error(
        "process-new-category translations insert failed",
        translationsError,
      );
    }

    try {
      const { data: configRow } = await supabase
        .from("app_config")
        .select("value")
        .eq("key", "admin_fcm_token")
        .maybeSingle();

      const adminToken = configRow?.value?.trim();
      if (adminToken) {
        await notifyAdmin(
          supabaseUrl,
          serviceRoleKey,
          "New Category Pending Review",
          `${titleLabel} suggested by vendor. Review in admin settings.`,
          adminToken,
        );
      }
    } catch (notifyErr) {
      console.error("process-new-category admin notify failed", notifyErr);
    }

    return jsonResponse({
      success: true,
      category_id,
      pending_review: true,
      ai_result,
    });
  } catch (err) {
    console.error("process-new-category failed", err);
    return jsonResponse({ success: false, error: "Internal error" });
  }
});
