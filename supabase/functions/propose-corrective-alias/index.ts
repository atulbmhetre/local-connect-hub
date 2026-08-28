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

type RequestBody = {
  term?: string;
  original_term_if_rephrased?: string | null;
  best_guess_category_id?: string;
  best_guess_category_label?: string;
  unresolved_id?: string | null;
  confidence?: number | null;
  healthCheck?: boolean;
  device_id?: string;
};

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
    p_function_name: "propose-corrective-alias",
    p_identifier_type: identifierType,
    p_identifier: identifier,
    p_max_requests: maxRequests,
    p_window_seconds: 60,
  });
  if (error) {
    console.error("propose-corrective-alias rate limit failed", identifierType, error);
    return null;
  }
  return data === true;
}

function normalizeTerm(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t || t.length < 2 || t.length > 80) return null;
  return t;
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

    const term = normalizeTerm(body.term ?? "");
    if (!term) {
      return jsonResponse({ success: false, error: "term required" }, 400);
    }

    const deviceId = body.device_id?.trim() || undefined;
    const ipAddress = clientIp(req);
    if (deviceId) {
      const allowed = await checkRateLimit(supabase, "device_id", deviceId, 10);
      if (allowed === false) {
        return jsonResponse({ success: false, error: "rate_limited" }, 429);
      }
    }
    const ipAllowed = await checkRateLimit(supabase, "ip", ipAddress, 40);
    if (ipAllowed === false) {
      return jsonResponse({ success: false, error: "rate_limited" }, 429);
    }

    let categoryId = body.best_guess_category_id?.trim() || "";
    let categoryLabel = "";

    if (categoryId) {
      const { data: cat } = await supabase
        .from("categories")
        .select("id, label")
        .eq("id", categoryId)
        .eq("is_active", true)
        .maybeSingle();
      if (!cat) {
        return jsonResponse({
          success: true,
          outcome: "no_usable_guess",
          reason: "category_not_active",
        });
      }
      categoryLabel = cat.label;
    } else {
      const label = body.best_guess_category_label?.trim() || "";
      if (!label) {
        // Gateway strips candidates on no_confident_match — without a client
        // best-guess there is nothing durable to propose.
        return jsonResponse({
          success: true,
          outcome: "no_usable_guess",
          reason: "missing_best_guess",
        });
      }
      const { data: cat } = await supabase
        .from("categories")
        .select("id, label")
        .eq("is_active", true)
        .ilike("label", label)
        .maybeSingle();
      if (!cat) {
        return jsonResponse({
          success: true,
          outcome: "no_usable_guess",
          reason: "label_not_found",
        });
      }
      categoryId = cat.id;
      categoryLabel = cat.label;
    }

    if (term === categoryLabel.trim().toLowerCase()) {
      return jsonResponse({
        success: true,
        outcome: "skipped_exact_label",
      });
    }

    const confidenceRaw = Number(body.confidence);
    const confidence =
      Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1
        ? confidenceRaw
        : 0.7;

    const original = body.original_term_if_rephrased?.trim() || null;
    const reasoning = original && original.toLowerCase() !== term
      ? `Customer searched “${original}”, rephrased to “${term}”, exhausted suggestions; AI best-guess was ${categoryLabel}.`
      : `Customer searched “${term}”, exhausted suggestions; AI best-guess was ${categoryLabel}.`;

    const { data: inserted, error: insertErr } = await supabase
      .from("category_search_terms")
      .insert({
        category_id: categoryId,
        term,
        language: "en",
        source: "corrective_ai",
        status: "pending_review",
        confidence,
        ai_reasoning: reasoning.slice(0, 500),
        suggested_by_vendor_id: null,
      })
      .select("id")
      .maybeSingle();

    if (insertErr) {
      if (insertErr.code === "23505") {
        // Term already exists for this category — still mark unresolved resolved.
      } else {
        console.error("propose-corrective-alias insert failed", insertErr);
        return jsonResponse({ success: false, error: "insert_failed" }, 500);
      }
    }

    const unresolvedId = body.unresolved_id?.trim() || null;
    if (unresolvedId) {
      await supabase.rpc("mark_unresolved_search_term_resolved", {
        p_unresolved_id: unresolvedId,
        p_resolved_category_id: categoryId,
      });
    } else {
      // Scheduled / retry path: mark newest matching unresolved row.
      const { data: rows } = await supabase
        .from("unresolved_search_terms")
        .select("id")
        .is("resolved_category_id", null)
        .ilike("term", term)
        .order("created_at", { ascending: false })
        .limit(1);
      const id = rows?.[0]?.id;
      if (id) {
        await supabase.rpc("mark_unresolved_search_term_resolved", {
          p_unresolved_id: id,
          p_resolved_category_id: categoryId,
        });
      }
    }

    return jsonResponse({
      success: true,
      outcome: inserted?.id ? "inserted" : "already_exists",
      term_id: inserted?.id ?? null,
      category_id: categoryId,
      category_label: categoryLabel,
      term,
    });
  } catch (err) {
    console.error("propose-corrective-alias failed", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
