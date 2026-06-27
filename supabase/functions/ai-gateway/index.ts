import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type GatewayAction = "classify_category";

type DbCategoryRow = {
  id: string;
  label: string;
  emoji: string | null;
  service_mode: string;
};

type ServiceMode = "help" | "delivery" | "appointment";

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

const CATEGORY_META = {
  Beautician: { mode: "help" as const, emoji: "💄", hindi: "ब्यूटीशियन" },
};

const classifyFallback = {
  canonical: "Other",
  emoji: "✨",
  hindi: "अन्य",
  mode: "help" as const,
};

function normalizeServiceMode(raw: string | null | undefined): ServiceMode {
  const mode = String(raw ?? "").trim().toLowerCase();
  if (mode === "delivery" || mode === "appointment") return mode;
  return "help";
}

function findDbCategory(dbCategories: DbCategoryRow[], label: string): DbCategoryRow | null {
  const lower = label.trim().toLowerCase();
  if (!lower) return null;
  return dbCategories.find((c) => c.label.trim().toLowerCase() === lower) ?? null;
}

function resolveCanonicalFromLabels(
  raw: string,
  validLabels: Set<string>,
  dbCategories: DbCategoryRow[],
): string {
  let canonical = raw.trim();
  if (!canonical) return "Other";

  if (!validLabels.has(canonical)) {
    const matched = dbCategories.find(
      (c) => c.label.trim().toLowerCase() === canonical.toLowerCase(),
    );
    canonical = matched?.label ?? "Other";
  }

  if (!validLabels.has(canonical)) {
    canonical = "Other";
  }

  return canonical;
}

async function fetchActiveCategories(
  supabase: ReturnType<typeof createClient>,
): Promise<{ categories: DbCategoryRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, label, emoji, service_mode")
    .eq("is_active", true);

  if (error) {
    console.error("ai-gateway categories load failed", error);
    return { categories: [], error: error.message };
  }

  return { categories: (data ?? []) as DbCategoryRow[], error: null };
}

async function invokeSuggestCategory(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: string,
  action: GatewayAction,
) {
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/suggest-category`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: input }),
    });

    if (!resp.ok) {
      console.error("ai-gateway suggest-category failed", resp.status, await resp.text());
      return jsonResponse({ action, result: classifyFallback });
    }

    const data = (await resp.json()) as {
      success?: boolean;
      category_name?: string;
      service_mode?: string;
      emoji?: string | null;
    };

    if (data.success && typeof data.category_name === "string" && data.category_name.trim()) {
      return jsonResponse({
        action,
        result: {
          canonical: data.category_name.trim(),
          mode: normalizeServiceMode(data.service_mode),
          emoji: data.emoji?.trim() || "✨",
          hindi: "अन्य",
        },
      });
    }

    return jsonResponse({ action, result: classifyFallback });
  } catch (err) {
    console.error("ai-gateway suggest-category invoke failed", err);
    return jsonResponse({ action, result: classifyFallback });
  }
}

function resultFromDbCategory(
  dbRow: DbCategoryRow,
  hindi?: string,
) {
  return {
    canonical: dbRow.label,
    mode: normalizeServiceMode(dbRow.service_mode),
    emoji: dbRow.emoji?.trim() || "✨",
    hindi: hindi?.trim() || "अन्य",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text?.trim()) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  try {
    const action = body?.action as GatewayAction | undefined;

    if (!action) {
      return jsonResponse({ error: "Missing action" }, 400);
    }

    if (action === "classify_category") {
      const input = String(body?.term ?? body?.input ?? "").trim();
      if (!input) return jsonResponse({ error: "Missing input" }, 400);

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      const supabase =
        supabaseUrl && serviceRoleKey
          ? createClient(supabaseUrl, serviceRoleKey)
          : null;

      const { categories: dbCategories, error: catError } = supabase
        ? await fetchActiveCategories(supabase)
        : { categories: [] as DbCategoryRow[], error: "missing_service_role" };

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

      if (catError || dbCategories.length === 0) {
        if (!supabaseUrl || !serviceRoleKey) {
          return jsonResponse({ action, result: classifyFallback });
        }
        return await invokeSuggestCategory(supabaseUrl, serviceRoleKey, input, action);
      }

      const validLabels = new Set(dbCategories.map((c) => c.label));
      const categoryList = dbCategories.map((c) => c.label).join(", ");
      const escapedInput = input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const system = `You are a strict category classifier for a hyperlocal service app in India called Aaspaas.

User input: "${escapedInput}"

You must classify this into ONE of these exact canonical categories:
${categoryList}

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
          if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse({ action, result: classifyFallback });
          }
          return await invokeSuggestCategory(supabaseUrl, serviceRoleKey, input, action);
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
          if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse({ action, result: classifyFallback });
          }
          return await invokeSuggestCategory(supabaseUrl, serviceRoleKey, input, action);
        }

        const canonical = resolveCanonicalFromLabels(
          result.canonical,
          validLabels,
          dbCategories,
        );

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

        const dbRow = findDbCategory(dbCategories, canonical);
        if (dbRow) {
          return jsonResponse({
            action,
            result: resultFromDbCategory(
              dbRow,
              typeof result.hindi === "string" ? result.hindi : undefined,
            ),
          });
        }

        if (!supabaseUrl || !serviceRoleKey) {
          return jsonResponse({ action, result: classifyFallback });
        }
        return await invokeSuggestCategory(supabaseUrl, serviceRoleKey, input, action);
      } catch {
        if (!supabaseUrl || !serviceRoleKey) {
          return jsonResponse({ action, result: classifyFallback });
        }
        return await invokeSuggestCategory(supabaseUrl, serviceRoleKey, input, action);
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
