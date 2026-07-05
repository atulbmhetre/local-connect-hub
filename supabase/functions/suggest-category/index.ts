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
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_THRESHOLD = 0.85;
const MEDIUM_MIN = 0.5;

type RequestBody = {
  description?: string;
  vendor_id?: string;
  create_pending?: boolean;
  healthCheck?: boolean;
  device_id?: string;
};

type AiSuggestion = {
  match_type: "existing" | "new";
  category_name: string;
  service_mode: "help" | "delivery" | "appointment";
  confidence: number;
  reasoning: string;
  emoji?: string;
};

type CategoryRow = {
  id: string;
  label: string;
  emoji: string | null;
  service_mode: string;
};

const SERVICE_MODES = new Set(["help", "delivery", "appointment"]);

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  identifierType: "device_id" | "ip",
  identifier: string,
  maxRequests: number,
): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("check_and_log_rate_limit", {
    p_function_name: "suggest-category",
    p_identifier_type: identifierType,
    p_identifier: identifier,
    p_max_requests: maxRequests,
    p_window_seconds: 60,
  });
  if (error) {
    console.error(
      "suggest-category rate limit RPC failed",
      identifierType,
      error,
    );
    return null;
  }
  return data === true;
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

function normalizeSuggestion(raw: AiSuggestion | null): AiSuggestion | null {
  if (!raw?.category_name?.trim()) return null;
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const service_mode = raw.service_mode;
  if (!SERVICE_MODES.has(service_mode)) return null;
  if (raw.match_type !== "existing" && raw.match_type !== "new") return null;
  return {
    match_type: raw.match_type,
    category_name: toTitleCase(raw.category_name),
    service_mode,
    confidence,
    reasoning: String(raw.reasoning ?? "").trim(),
    emoji: raw.emoji?.trim() || "✨",
  };
}

function buildPrompt(categories: CategoryRow[], description: string): string {
  const list = categories
    .map((c) => `- ${c.label} (${c.service_mode})`)
    .join("\n");

  return `You are helping categorize a local business for a hyperlocal service app in India.

Existing categories:
${list}

Business description: "${description.replace(/"/g, '\\"')}"

Respond ONLY with JSON:
{
  "match_type": "existing" | "new",
  "category_name": "matched or suggested name",
  "service_mode": "help" | "delivery" | "appointment",
  "confidence": 0.0,
  "reasoning": "one line explanation",
  "emoji": "single emoji (for new categories)"
}

Rules:
- match_type "existing" only if the business clearly fits an existing category name
- match_type "new" if no existing category is a good fit
- service_mode: help = on-demand/emergency visit; delivery = goods delivered; appointment = scheduled service
- confidence reflects how sure you are (0.0 to 1.0)`;
}

async function loadConfig(
  supabase: ReturnType<typeof createClient>,
): Promise<{ threshold: number; model: string }> {
  const { data } = await supabase
    .from("app_config")
    .select("key, value")
    .in("key", ["ai_category_confidence_threshold", "ai_category_model"]);

  let threshold = DEFAULT_THRESHOLD;
  let model = DEFAULT_MODEL;
  for (const row of data ?? []) {
    if (row.key === "ai_category_confidence_threshold") {
      const n = Number(String(row.value ?? "").trim());
      if (Number.isFinite(n) && n > 0 && n <= 1) threshold = n;
    }
    if (row.key === "ai_category_model") {
      const m = String(row.value ?? "").trim();
      if (m) model = m;
    }
  }
  return { threshold, model };
}

async function callClaude(
  model: string,
  prompt: string,
): Promise<AiSuggestion> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("suggest-category Anthropic error", resp.status, errText);
    throw new Error("AI suggestion failed", { cause: errText });
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

  const parsed = normalizeSuggestion(extractJson<AiSuggestion>(text));
  if (!parsed) {
    console.error("suggest-category invalid AI JSON", text);
    throw new Error("Invalid AI response");
  }
  return parsed;
}

function findExistingCategory(
  categories: CategoryRow[],
  name: string,
): CategoryRow | null {
  const normalized = name.trim().toLowerCase();
  return (
    categories.find((c) => c.label.trim().toLowerCase() === normalized) ?? null
  );
}

function topPicks(
  categories: CategoryRow[],
  description: string,
  limit = 3,
): CategoryRow[] {
  const tokens = description
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  const scored = categories.map((cat) => {
    const label = cat.label.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (label.includes(token)) score += 2;
    }
    if (description.toLowerCase().includes(label)) score += 5;
    return { cat, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.cat);
}

async function notifyAdmin(
  supabaseUrl: string,
  serviceRoleKey: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/notify-admin`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      console.error("suggest-category notify-admin failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("suggest-category notify-admin invoke failed", err);
  }
}

async function notifyAdminInbox(
  supabase: ReturnType<typeof createClient>,
  title: string,
  body: string,
): Promise<void> {
  const { data: configRow } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "admin_phone")
    .maybeSingle();
  const adminPhone = configRow?.value?.trim();
  if (!adminPhone) return;

  await supabase.from("user_notifications").insert({
    user_phone: adminPhone,
    type: "admin_alert",
    title,
    body,
    route: "settings",
    is_informational: false,
    is_read: false,
  });
}

async function upsertPendingNewCategory(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
  suggestion: AiSuggestion,
  vendorId: string,
  threshold: number,
): Promise<{
  category_id: string;
  outcome: "new_pending" | "new_auto_approved";
}> {
  const titleLabel = suggestion.category_name;
  const normalized = titleLabel.trim().toLowerCase();

  const { data: pendingRows, error: pendingError } = await supabase
    .from("categories")
    .select("id, label, suggestion_count, status, pending_review")
    .or("status.eq.pending_review,pending_review.eq.true")
    .eq("is_active", false);

  if (pendingError) {
    console.error("suggest-category pending lookup failed", pendingError);
    throw new Error("Database error");
  }

  const existingPending = (pendingRows ?? []).find(
    (r) => r.label?.trim().toLowerCase() === normalized,
  );

  if (existingPending) {
    const nextCount = (existingPending.suggestion_count ?? 0) + 1;
    const autoApprove = nextCount >= 2;

    const { error: updateError } = await supabase
      .from("categories")
      .update({
        suggestion_count: nextCount,
        ...(autoApprove
          ? {
            status: "active",
            is_active: true,
            pending_review: false,
            ai_confidence_score: suggestion.confidence,
            ai_reasoning: suggestion.reasoning,
          }
          : {}),
      })
      .eq("id", existingPending.id);

    if (updateError) {
      console.error("suggest-category pending update failed", updateError);
      throw new Error("Failed to update category");
    }

    if (autoApprove) {
      return {
        category_id: existingPending.id,
        outcome: "new_auto_approved",
      };
    }

    return {
      category_id: existingPending.id,
      outcome: "new_pending",
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("categories")
    .insert({
      label: titleLabel,
      emoji: suggestion.emoji ?? "✨",
      service_mode: suggestion.service_mode,
      is_active: false,
      pending_review: true,
      status: "pending_review",
      sort_order: 99,
      suggested_by_vendor_id: vendorId,
      ai_confidence: suggestion.confidence >= threshold
        ? "high"
        : suggestion.confidence >= MEDIUM_MIN
        ? "medium"
        : "low",
      ai_confidence_score: suggestion.confidence,
      ai_reasoning: suggestion.reasoning,
      suggestion_count: 1,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    console.error("suggest-category insert failed", insertError);
    throw new Error("Failed to create category");
  }

  const adminTitle = "New category suggested";
  const adminBody =
    `${titleLabel} / ${suggestion.service_mode} — ${suggestion.reasoning}`;
  await notifyAdmin(supabaseUrl, serviceRoleKey, adminTitle, adminBody);
  await notifyAdminInbox(supabase, adminTitle, adminBody);

  return { category_id: inserted.id, outcome: "new_pending" };
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
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    if (body.healthCheck === true || body.description?.trim() === "health-check") {
      return jsonResponse({ status: "ok" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ success: false, error: "Server misconfigured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const deviceId = body.device_id?.trim() || undefined;
    const ipAddress = clientIp(req);

    if (deviceId) {
      const deviceAllowed = await checkRateLimit(supabase, "device_id", deviceId, 5);
      if (deviceAllowed === false) {
        return jsonResponse({
          success: false,
          error: "Too many requests, please wait a moment and try again.",
        }, 429);
      }
    }

    const ipAllowed = await checkRateLimit(supabase, "ip", ipAddress, 20);
    if (ipAllowed === false) {
      return jsonResponse({
        success: false,
        error: "Too many requests, please wait a moment and try again.",
      }, 429);
    }

    const description = body.description?.trim();
    if (!description || description.length < 3) {
      return jsonResponse({
        success: false,
        error: "Missing or too short description",
      }, 400);
    }

    const vendorId = body.vendor_id?.trim() || undefined;
    const createPending = body.create_pending === true;

    const { threshold, model } = await loadConfig(supabase);

    const { data: categories, error: catError } = await supabase
      .from("categories")
      .select("id, label, emoji, service_mode")
      .eq("is_active", true)
      .or("status.eq.active,status.is.null")
      .order("sort_order", { ascending: true });

    if (catError) {
      console.error("suggest-category categories load failed", catError);
      return jsonResponse({ success: false, error: "Database error" }, 500);
    }

    const activeCategories = (categories ?? []) as CategoryRow[];

    let suggestion: AiSuggestion;
    try {
      suggestion = await callClaude(model, buildPrompt(activeCategories, description));
    } catch (err) {
      console.error("suggest-category AI failed", err);
      try {
        const errMessage = err instanceof Error ? err.message : String(err);
        const errBody = err instanceof Error && typeof err.cause === "string"
          ? err.cause
          : "";
        if (/credit balance/i.test(`${errMessage} ${errBody}`)) {
          const rawError = (errBody || errMessage).slice(0, 1000);
          const now = new Date().toISOString();
          await supabase.from("admin_alerts").upsert(
            {
              function_name: "suggest-category",
              error_type: "billing",
              raw_error: rawError,
              last_checked_at: now,
              notified: false,
            },
            { onConflict: "function_name", ignoreDuplicates: false },
          );
        }
      } catch (alertErr) {
        console.error("suggest-category admin_alerts upsert failed", alertErr);
      }
      return jsonResponse({
        success: false,
        error: err instanceof Error ? err.message : "AI suggestion failed",
      }, 502);
    }

    if (suggestion.confidence < MEDIUM_MIN) {
      const picks = topPicks(activeCategories, description, 3);
      return jsonResponse({
        success: true,
        outcome: "low_confidence",
        confidence: suggestion.confidence,
        reasoning: suggestion.reasoning,
        top_picks: picks.map((c) => ({
          id: c.id,
          label: c.label,
          emoji: c.emoji,
          service_mode: c.service_mode,
        })),
      });
    }

    if (suggestion.match_type === "existing") {
      const matched =
        findExistingCategory(activeCategories, suggestion.category_name) ??
        activeCategories.find((c) =>
          c.label.toLowerCase().includes(suggestion.category_name.toLowerCase()) ||
          suggestion.category_name.toLowerCase().includes(c.label.toLowerCase())
        ) ??
        null;

      if (!matched) {
        const picks = topPicks(activeCategories, description, 3);
        return jsonResponse({
          success: true,
          outcome: "low_confidence",
          confidence: suggestion.confidence,
          reasoning: suggestion.reasoning,
          top_picks: picks.map((c) => ({
            id: c.id,
            label: c.label,
            emoji: c.emoji,
            service_mode: c.service_mode,
          })),
        });
      }

      if (suggestion.confidence >= threshold) {
        return jsonResponse({
          success: true,
          outcome: "high_existing",
          category_id: matched.id,
          category_name: matched.label,
          service_mode: matched.service_mode,
          confidence: suggestion.confidence,
          reasoning: suggestion.reasoning,
          emoji: matched.emoji,
        });
      }

      return jsonResponse({
        success: true,
        outcome: "medium_existing",
        category_id: matched.id,
        category_name: matched.label,
        service_mode: matched.service_mode,
        confidence: suggestion.confidence,
        reasoning: suggestion.reasoning,
        emoji: matched.emoji,
      });
    }

    if (!createPending) {
      return jsonResponse({
        success: true,
        outcome: suggestion.confidence >= threshold
          ? "new_suggested"
          : "medium_new",
        category_name: suggestion.category_name,
        service_mode: suggestion.service_mode,
        confidence: suggestion.confidence,
        reasoning: suggestion.reasoning,
        emoji: suggestion.emoji,
        requires_confirm: true,
      });
    }

    if (!vendorId) {
      return jsonResponse({
        success: false,
        error: "vendor_id required to create pending category",
      }, 400);
    }

    const created = await upsertPendingNewCategory(
      supabase,
      supabaseUrl,
      serviceRoleKey,
      suggestion,
      vendorId,
      threshold,
    );

    return jsonResponse({
      success: true,
      outcome: created.outcome,
      category_id: created.category_id,
      category_name: suggestion.category_name,
      service_mode: suggestion.service_mode,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      emoji: suggestion.emoji,
      pending_review: created.outcome === "new_pending",
    });
  } catch (err) {
    console.error("suggest-category failed", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
