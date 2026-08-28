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
const MIN_INSERT_CONFIDENCE = 0.55;
const MAX_ALIASES = 6;

type RequestBody = {
  vendor_id?: string;
  category_id?: string;
  healthCheck?: boolean;
  device_id?: string;
};

type ProposedAlias = {
  term: string;
  confidence: number;
  reasoning: string;
};

type AiResponse = {
  aliases: ProposedAlias[];
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  identifierType: "device_id" | "ip" | "vendor_id",
  identifier: string,
  maxRequests: number,
): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("check_and_log_rate_limit", {
    p_function_name: "suggest-category-aliases",
    p_identifier_type: identifierType,
    p_identifier: identifier,
    p_max_requests: maxRequests,
    p_window_seconds: 60,
  });
  if (error) {
    console.error("suggest-category-aliases rate limit RPC failed", identifierType, error);
    return null;
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

function normalizeTerm(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t || t.length < 2 || t.length > 40) return null;
  return t;
}

function normalizeAliases(raw: unknown): ProposedAlias[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedAlias[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const term = normalizeTerm(String((item as { term?: string }).term ?? ""));
    if (!term || seen.has(term)) continue;
    const confidence = Number((item as { confidence?: number }).confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    const reasoning = String((item as { reasoning?: string }).reasoning ?? "").trim();
    if (!reasoning) continue;
    seen.add(term);
    out.push({ term, confidence, reasoning });
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

function buildPrompt(params: {
  categoryLabel: string;
  shopName: string;
  brandName: string | null;
  vendorNote: string | null;
  menuItems: string[];
  existingAliases: string[];
}): string {
  const menuBlock = params.menuItems.length > 0
    ? params.menuItems.map((m) => `- ${m}`).join("\n")
    : "(no menu items yet)";

  const existingBlock = params.existingAliases.length > 0
    ? params.existingAliases.join(", ")
    : "(none)";

  const note = (params.vendorNote ?? "").replace(/"/g, '\\"');
  const shop = params.shopName.replace(/"/g, '\\"');
  const brand = (params.brandName ?? params.shopName).replace(/"/g, '\\"');
  const cat = params.categoryLabel.replace(/"/g, '\\"');

  return `You propose customer search aliases for a hyperlocal service app in India.

The vendor is ALREADY classified under category: "${cat}"

Vendor profile (read as ONE whole — never isolate a single word):
- Shop / brand name: "${shop}"
- Brand label on this category: "${brand}"
- Vendor note: "${note || "(none)"}"
- Menu / price list:
${menuBlock}

Existing search aliases for this category (do NOT repeat): ${existingBlock}

Respond ONLY with JSON:
{
  "aliases": [
    { "term": "short search phrase", "confidence": 0.0, "reasoning": "one line tied to the FULL profile" }
  ]
}

CRITICAL — whole-profile reasoning (anti keyword-trap):
- Reason over the ENTIRE profile together: category + shop/brand + note + all menu items.
- NEVER propose an alias because ONE word appears in isolation.
  Example: "milk" on a restaurant menu does NOT mean Dairy — read whether this is a dairy vendor or a restaurant.
  Example: "kirana" fits Grocery Store only when the overall profile is a neighbourhood goods shop, not a café that sells snacks.
- Each alias must reflect how a CUSTOMER would search for THIS specific business and its offerings under "${cat}".
- Use English and common Hinglish spelling variants; 3–6 aliases max.
- Omit the exact category label and terms already listed in existing aliases.
- confidence 0.0–1.0 reflects how strongly the FULL profile supports that search term.`;
}

async function loadModel(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ai_category_model")
    .maybeSingle();
  const m = String(data?.value ?? "").trim();
  return m || DEFAULT_MODEL;
}

async function callClaude(model: string, prompt: string): Promise<ProposedAlias[]> {
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
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("suggest-category-aliases Anthropic error", resp.status, errText);
    throw new Error("AI alias proposal failed");
  }

  const data = await resp.json();
  const text =
    Array.isArray(data?.content)
      ? data.content
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b.text ?? "")
        .join("")
        .trim()
      : "";

  const parsed = extractJson<AiResponse>(text);
  if (!parsed) {
    console.error("suggest-category-aliases invalid AI JSON", text);
    throw new Error("Invalid AI response");
  }
  return normalizeAliases(parsed.aliases);
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

    if (body.healthCheck === true) {
      return jsonResponse({ status: "ok" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ success: false, error: "Server misconfigured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const vendorId = body.vendor_id?.trim();
    const categoryId = body.category_id?.trim();
    if (!vendorId || !categoryId) {
      return jsonResponse({ success: false, error: "vendor_id and category_id required" }, 400);
    }

    const deviceId = body.device_id?.trim() || undefined;
    const ipAddress = clientIp(req);

    if (deviceId) {
      const allowed = await checkRateLimit(supabase, "device_id", deviceId, 8);
      if (allowed === false) {
        return jsonResponse({ success: false, error: "rate_limited" }, 429);
      }
    }

    const ipAllowed = await checkRateLimit(supabase, "ip", ipAddress, 30);
    if (ipAllowed === false) {
      return jsonResponse({ success: false, error: "rate_limited" }, 429);
    }

    const vendorAllowed = await checkRateLimit(supabase, "vendor_id", vendorId, 4);
    if (vendorAllowed === false) {
      return jsonResponse({ success: true, outcome: "rate_limited", inserted: 0 });
    }

    const { data: vendor, error: vendorErr } = await supabase
      .from("vendors")
      .select("id, shop_name")
      .eq("id", vendorId)
      .maybeSingle();

    if (vendorErr || !vendor) {
      return jsonResponse({ success: false, error: "vendor not found" }, 404);
    }

    const { data: category, error: catErr } = await supabase
      .from("categories")
      .select("id, label")
      .eq("id", categoryId)
      .eq("is_active", true)
      .maybeSingle();

    if (catErr || !category) {
      return jsonResponse({ success: false, error: "category not found" }, 404);
    }

    const { data: vcRow } = await supabase
      .from("vendor_categories")
      .select("vendor_note, brand_name, status")
      .eq("vendor_id", vendorId)
      .eq("category_id", categoryId)
      .maybeSingle();

    if (!vcRow || vcRow.status !== "approved") {
      return jsonResponse({ success: false, error: "vendor category not approved" }, 400);
    }

    const { data: menuRows } = await supabase
      .from("vendor_menu_items")
      .select("name, price, unit, description, is_available")
      .eq("vendor_id", vendorId)
      .eq("category_id", categoryId)
      .order("sort_order", { ascending: true })
      .limit(40);

    const menuItems = (menuRows ?? [])
      .filter((m) => m.is_available !== false)
      .map((m) => {
        const name = String(m.name ?? "").trim();
        const unit = m.unit ? ` (${m.unit})` : "";
        const price = m.price != null ? ` ₹${m.price}` : "";
        const desc = m.description ? ` — ${String(m.description).trim()}` : "";
        return `${name}${unit}${price}${desc}`.trim();
      })
      .filter(Boolean);

    const { data: existingRows } = await supabase
      .from("category_search_terms")
      .select("term")
      .eq("category_id", categoryId);

    const existingAliases = (existingRows ?? [])
      .map((r) => String(r.term ?? "").trim().toLowerCase())
      .filter(Boolean);

    const model = await loadModel(supabase);
    let proposals: ProposedAlias[];
    try {
      proposals = await callClaude(
        model,
        buildPrompt({
          categoryLabel: category.label,
          shopName: vendor.shop_name ?? "",
          brandName: vcRow.brand_name ?? null,
          vendorNote: vcRow.vendor_note ?? null,
          menuItems,
          existingAliases,
        }),
      );
    } catch (err) {
      console.error("suggest-category-aliases AI failed", err);
      return jsonResponse({ success: false, error: "AI failed" }, 502);
    }

    const categoryLabelNorm = category.label.trim().toLowerCase();
    let inserted = 0;

    for (const alias of proposals) {
      if (alias.confidence < MIN_INSERT_CONFIDENCE) continue;
      if (alias.term === categoryLabelNorm) continue;
      if (existingAliases.includes(alias.term)) continue;

      const { error: insertErr } = await supabase.from("category_search_terms").insert({
        category_id: categoryId,
        term: alias.term,
        language: "en",
        source: "proactive_ai",
        status: "pending_review",
        confidence: alias.confidence,
        ai_reasoning: alias.reasoning.slice(0, 500),
        suggested_by_vendor_id: vendorId,
      });

      if (insertErr) {
        if (insertErr.code !== "23505") {
          console.error("suggest-category-aliases insert failed", insertErr);
        }
        continue;
      }
      inserted += 1;
      existingAliases.push(alias.term);
    }

    return jsonResponse({
      success: true,
      outcome: inserted > 0 ? "inserted" : "no_new_aliases",
      inserted,
      proposed: proposals.length,
    });
  } catch (err) {
    console.error("suggest-category-aliases failed", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
