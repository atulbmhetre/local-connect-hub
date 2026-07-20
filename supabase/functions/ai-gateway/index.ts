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

/** One ranked suggestion in the classify_category response. */
type ClassifyCandidate = { label: string; emoji: string; mode: ServiceMode };

/**
 * Upper bound on ranked suggestions returned to the client. Home shows the
 * first 5 as Tier 1 and the rest (up to this cap) as Tier 2.
 */
const MAX_CANDIDATES = 10;

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

function normalizeServiceMode(raw: string | null | undefined): ServiceMode {
  const mode = String(raw ?? "").trim().toLowerCase();
  if (mode === "delivery" || mode === "appointment") return mode;
  return "help";
}

function candidateFromDbRow(row: DbCategoryRow): ClassifyCandidate {
  return {
    label: row.label,
    emoji: row.emoji?.trim() || "✨",
    mode: normalizeServiceMode(row.service_mode),
  };
}

function findDbCategory(dbCategories: DbCategoryRow[], label: string): DbCategoryRow | null {
  const lower = label.trim().toLowerCase();
  if (!lower) return null;
  return dbCategories.find((c) => c.label.trim().toLowerCase() === lower) ?? null;
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

/**
 * Resilience fallback when Groq is unavailable or returns garbage: ask the
 * suggest-category classifier for its single best match and surface it as a
 * one-item candidate list (still user-confirmed on the client, never
 * auto-navigated).
 */
async function invokeSuggestCategory(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: string,
  action: GatewayAction,
  dbCategories: DbCategoryRow[],
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
      return jsonResponse({ action, result: { candidates: [] } });
    }

    const data = (await resp.json()) as {
      success?: boolean;
      category_name?: string;
      service_mode?: string;
      emoji?: string | null;
    };

    if (data.success && typeof data.category_name === "string" && data.category_name.trim()) {
      const name = data.category_name.trim();
      const dbRow = findDbCategory(dbCategories, name);
      if (dbRow) {
        return jsonResponse({ action, result: { candidates: [candidateFromDbRow(dbRow)] } });
      }
      // Category list unavailable — trust the suggestion rather than dead-end.
      if (dbCategories.length === 0) {
        return jsonResponse({
          action,
          result: {
            candidates: [
              {
                label: name,
                emoji: data.emoji?.trim() || "✨",
                mode: normalizeServiceMode(data.service_mode),
              },
            ],
          },
        });
      }
      // Suggestion is a not-yet-active category — nothing searchable on Radar.
      return jsonResponse({ action, result: { candidates: [] } });
    }

    return jsonResponse({ action, result: { candidates: [] } });
  } catch (err) {
    console.error("ai-gateway suggest-category invoke failed", err);
    return jsonResponse({ action, result: { candidates: [] } });
  }
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
            candidates: [],
            is_government: true,
            message: "Search for Ambulance, Doctor, or Nursing instead",
          },
        });
      }

      if (
        /\b(fire station|fire brigade|agni\s*shaman|agnishaman)\b/i.test(input)
      ) {
        const fireRow = findDbCategory(dbCategories, "Fire Brigade");
        return jsonResponse({
          action,
          result: {
            candidates: [
              fireRow
                ? candidateFromDbRow(fireRow)
                : { label: "Fire Brigade", emoji: "🔥", mode: "help" as ServiceMode },
            ],
          },
        });
      }

      if (catError || dbCategories.length === 0) {
        if (!supabaseUrl || !serviceRoleKey) {
          return jsonResponse({ action, result: { candidates: [] } });
        }
        return await invokeSuggestCategory(
          supabaseUrl,
          serviceRoleKey,
          input,
          action,
          dbCategories,
        );
      }

      const categoryLines = dbCategories
        .map((c) => `${c.label} (${normalizeServiceMode(c.service_mode)})`)
        .join("\n");
      const escapedInput = input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const system = `You are a category-suggestion assistant for Aaspaas, a hyperlocal service app in India.

A customer typed this free-text search (English, Hindi, Marathi, or a full sentence):
"${escapedInput}"

Active service categories (label (mode)):
${categoryLines}

Rank the categories that could plausibly help with the customer's need, most relevant first.

Rules:
1. Return ONLY valid JSON, no other text.
2. "candidates" is an ordered array of category labels copied EXACTLY from the list above — most relevant first, at most ${MAX_CANDIDATES}. Include a category only if it could plausibly serve the need; omit clearly irrelevant ones. It is fine to return fewer, or an empty array if nothing fits.
3. If the input asks for a government or emergency service (police, fire, hospital), set "is_government": true and write one short helpful "message"; "candidates" may be empty.
4. NEVER invent labels that are not in the list.
5. Therapist and Beautician are permanently distinct categories, and BOTH plausibly serve wellness / body-care needs (massage, spa, therapy, physiotherapy, relaxation, salon-style body treatments). For any such wellness-adjacent query, include BOTH "Therapist" and "Beautician" as candidates when they appear in the list above — never pick just one; the customer chooses.

Response format:
{
  "candidates": ["<label>", "<label>"],
  "is_government": false,
  "message": "only if is_government is true"
}`;

      try {
        const { text } = await callGroq(system, input, 0.08);
        const parsed = extractJson<{
          candidates?: unknown;
          is_government?: boolean;
          message?: string;
        }>(text);

        if (!parsed || typeof parsed !== "object") {
          return await invokeSuggestCategory(
            supabaseUrl!,
            serviceRoleKey!,
            input,
            action,
            dbCategories,
          );
        }

        if (parsed.is_government === true) {
          const message =
            typeof parsed.message === "string" && parsed.message.trim()
              ? parsed.message.trim()
              : "This is a government or emergency service — use official helplines.";
          return jsonResponse({
            action,
            result: { candidates: [], is_government: true, message },
          });
        }

        const seen = new Set<string>();
        const candidates: ClassifyCandidate[] = [];
        const rawList = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        for (const raw of rawList) {
          if (typeof raw !== "string") continue;
          const dbRow = findDbCategory(dbCategories, raw);
          if (!dbRow || seen.has(dbRow.id)) continue;
          seen.add(dbRow.id);
          candidates.push(candidateFromDbRow(dbRow));
          if (candidates.length >= MAX_CANDIDATES) break;
        }

        if (candidates.length > 0) {
          return jsonResponse({ action, result: { candidates } });
        }

        return await invokeSuggestCategory(
          supabaseUrl!,
          serviceRoleKey!,
          input,
          action,
          dbCategories,
        );
      } catch {
        return await invokeSuggestCategory(
          supabaseUrl!,
          serviceRoleKey!,
          input,
          action,
          dbCategories,
        );
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
