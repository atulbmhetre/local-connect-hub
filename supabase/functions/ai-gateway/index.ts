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

async function fetchConfidenceThreshold(
  supabase: ReturnType<typeof createClient>,
): Promise<number> {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ai_category_confidence_threshold")
    .maybeSingle();
  if (error) {
    console.error("ai-gateway threshold load failed", error);
    return 0.85;
  }
  const n = Number((data as { value?: string } | null)?.value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.85;
}

function noConfidentMatchResponse(action: GatewayAction) {
  return jsonResponse({
    action,
    result: { candidates: [], no_confident_match: true },
  });
}

/**
 * Body-care / wellness queries (rule 6). Therapist was removed from the catalog;
 * Beautician is the sole wellness category — force it alone when ambiguous.
 */
const WELLNESS_AMBIGUOUS_PATTERNS = [
  /\bmassage\b/i,
  /\bphysio(?:therapy)?\b/i,
  /\bspa\b/i,
  /\bwellness\b/i,
  /\bbody\s*care\b/i,
  /\brelaxation\b/i,
  /\btherapist\b/i,
  /\btherapy\b/i,
];

function isExplicitSingleWellnessCategoryLookup(input: string): boolean {
  const t = input.trim().toLowerCase();
  return t === "beautician" || t === "therapist";
}

function matchesWellnessAmbiguousTerm(input: string): boolean {
  if (isExplicitSingleWellnessCategoryLookup(input)) return false;
  return WELLNESS_AMBIGUOUS_PATTERNS.some((re) => re.test(input));
}

function rawListMentionsWellnessCategory(rawList: readonly unknown[]): boolean {
  for (const raw of rawList) {
    if (typeof raw !== "string") continue;
    const lower = raw.trim().toLowerCase();
    // Therapist may still appear in model output from stale training; treat as wellness.
    if (lower === "therapist" || lower === "beautician") return true;
  }
  return false;
}

function shouldForceWellnessBeautician(
  input: string,
  rawCandidateLabels: readonly unknown[],
): boolean {
  if (isExplicitSingleWellnessCategoryLookup(input)) return false;
  return (
    matchesWellnessAmbiguousTerm(input) ||
    rawListMentionsWellnessCategory(rawCandidateLabels)
  );
}

/** Sole wellness catalog category after Therapist removal. */
function buildWellnessBeauticianCandidate(
  dbCategories: DbCategoryRow[],
): ClassifyCandidate[] | null {
  const beautician = findDbCategory(dbCategories, "Beautician");
  if (!beautician) return null;
  return [candidateFromDbRow(beautician)];
}

function wellnessBeauticianResponse(
  action: GatewayAction,
  dbCategories: DbCategoryRow[],
  threshold: number,
  modelConfidence: number,
) {
  const candidates = buildWellnessBeauticianCandidate(dbCategories);
  if (!candidates) return null;
  const confidence = Math.max(
    threshold,
    Number.isFinite(modelConfidence) ? modelConfidence : 0,
  );
  return jsonResponse({
    action,
    result: { candidates, confidence },
  });
}

/**
 * Last-resort when Groq is down: only surface suggest-category's high-confidence
 * existing match. Never force a medium/low nearest-neighbour guess.
 */
async function invokeSuggestCategory(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: string,
  action: GatewayAction,
  dbCategories: DbCategoryRow[],
  threshold: number,
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
      return noConfidentMatchResponse(action);
    }

    const data = (await resp.json()) as {
      success?: boolean;
      outcome?: string;
      category_name?: string;
      service_mode?: string;
      emoji?: string | null;
      confidence?: number;
    };

    const confidence = Number(data.confidence);
    const confident =
      data.success === true &&
      data.outcome === "high_existing" &&
      Number.isFinite(confidence) &&
      confidence >= threshold &&
      typeof data.category_name === "string" &&
      data.category_name.trim();

    if (!confident) {
      const suggestRaw = typeof data.category_name === "string" && data.category_name.trim()
        ? [data.category_name.trim()]
        : [];
      if (shouldForceWellnessBeautician(input, suggestRaw)) {
        const forced = wellnessBeauticianResponse(
          action,
          dbCategories,
          threshold,
          confidence,
        );
        if (forced) return forced;
      }
      return noConfidentMatchResponse(action);
    }

    const name = data.category_name!.trim();
    const dbRow = findDbCategory(dbCategories, name);
    if (dbRow) {
      return jsonResponse({
        action,
        result: {
          candidates: [candidateFromDbRow(dbRow)],
          confidence,
        },
      });
    }

    return noConfidentMatchResponse(action);
  } catch (err) {
    console.error("ai-gateway suggest-category invoke failed", err);
    return noConfidentMatchResponse(action);
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

      const threshold = supabase ? await fetchConfidenceThreshold(supabase) : 0.85;

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
            confidence: 1,
          },
        });
      }

      if (catError || dbCategories.length === 0) {
        if (!supabaseUrl || !serviceRoleKey) {
          return noConfidentMatchResponse(action);
        }
        return await invokeSuggestCategory(
          supabaseUrl,
          serviceRoleKey,
          input,
          action,
          dbCategories,
          threshold,
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

Rank ONLY categories that are a clear, genuine fit for the customer's need, most relevant first.

Rules:
1. Return ONLY valid JSON, no other text.
2. "candidates" is an ordered array of category labels copied EXACTLY from the list above — most relevant first, at most ${MAX_CANDIDATES}. Include a category only when it clearly serves the need. Prefer an empty array over a weak or tangential guess (e.g. do NOT map shoe repair / cobbler to Mechanic or Beautician).
3. "confidence" is a number from 0.0 to 1.0 for how sure you are that the top candidates truly match. Use < ${threshold} when the need is not covered by any listed category or when you are guessing.
4. If the input asks for a government or emergency service (police, fire, hospital), set "is_government": true and write one short helpful "message"; "candidates" may be empty; set confidence to 1.
5. NEVER invent labels that are not in the list.
6. Beautician is the sole wellness / body-care category (massage, spa, therapy, physiotherapy, relaxation, salon-style body treatments). Therapist is no longer in the catalog — never suggest it. For any wellness-adjacent query that clearly fits those services, include "Beautician" when it appears in the list. If the query is NOT wellness/body-care (e.g. cobbler, shoe repair), do not include Beautician.

Response format:
{
  "candidates": ["<label>", "<label>"],
  "confidence": 0.0,
  "is_government": false,
  "message": "only if is_government is true"
}`;

      try {
        const { text } = await callGroq(system, input, 0.08);
        const parsed = extractJson<{
          candidates?: unknown;
          confidence?: unknown;
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
            threshold,
          );
        }

        if (parsed.is_government === true) {
          const message =
            typeof parsed.message === "string" && parsed.message.trim()
              ? parsed.message.trim()
              : "This is a government or emergency service — use official helplines.";
          return jsonResponse({
            action,
            result: { candidates: [], is_government: true, message, confidence: 1 },
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

        const confidenceRaw = Number(parsed.confidence);
        const confidence = Number.isFinite(confidenceRaw)
          ? Math.min(1, Math.max(0, confidenceRaw))
          : candidates.length > 0
            ? 0
            : 0;

        if (shouldForceWellnessBeautician(input, rawList)) {
          const forced = wellnessBeauticianResponse(
            action,
            dbCategories,
            threshold,
            confidence,
          );
          if (forced) return forced;
        }

        // No candidates, or model is not confident enough → do not force a guess.
        if (candidates.length === 0 || confidence < threshold) {
          return noConfidentMatchResponse(action);
        }

        return jsonResponse({
          action,
          result: { candidates, confidence },
        });
      } catch {
        return await invokeSuggestCategory(
          supabaseUrl!,
          serviceRoleKey!,
          input,
          action,
          dbCategories,
          threshold,
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
