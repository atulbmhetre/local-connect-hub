import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const FETCH_TIMEOUT_MS = 10_000;
const EXPIRY_WINDOW_DAYS = 30;

type ErrorType = "billing" | "model" | "timeout" | "unknown";

type CheckSummary = {
  key: string;
  ok: boolean;
  action?: "alert" | "resolved" | "skipped";
  message?: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

async function resolveAlert(
  supabase: ReturnType<typeof createClient>,
  functionName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("admin_alerts")
    .update({ resolved_at: now, last_checked_at: now })
    .eq("function_name", functionName)
    .is("resolved_at", null);
}

async function upsertFailureAlert(
  supabase: ReturnType<typeof createClient>,
  functionName: string,
  errorType: ErrorType,
  rawError: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("admin_alerts").upsert(
    {
      function_name: functionName,
      error_type: errorType,
      raw_error: rawError.slice(0, 1000),
      last_checked_at: now,
      notified: false,
    },
    { onConflict: "function_name", ignoreDuplicates: false },
  );
}

function daysUntilDate(dateValue: string): number | null {
  const trimmed = dateValue.trim();
  if (!trimmed) return null;
  const expiry = new Date(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(expiry.getTime())) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiryUtc = Date.UTC(
    expiry.getUTCFullYear(),
    expiry.getUTCMonth(),
    expiry.getUTCDate(),
  );
  return Math.ceil((expiryUtc - todayUtc) / (24 * 60 * 60 * 1000));
}

function isExpiryKey(key: string): boolean {
  return key.endsWith("_renewal") || key.endsWith("_kyc_date");
}

async function loadConfigValue(
  supabase: ReturnType<typeof createClient>,
  key: string,
  fallback = "",
): Promise<string> {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error(`check-expiry-alerts config load failed for ${key}`, error);
    return fallback;
  }
  return data?.value?.trim() ?? fallback;
}

async function checkExpiryDates(
  supabase: ReturnType<typeof createClient>,
): Promise<CheckSummary[]> {
  const { data, error } = await supabase.from("app_config").select("key, value");
  if (error) {
    console.error("check-expiry-alerts app_config load failed", error);
    return [{ key: "app_config", ok: false, action: "skipped", message: error.message }];
  }

  const summaries: CheckSummary[] = [];
  for (const row of data ?? []) {
    if (!isExpiryKey(row.key)) continue;

    const days = daysUntilDate(String(row.value ?? ""));
    if (days == null) {
      summaries.push({
        key: row.key,
        ok: false,
        action: "skipped",
        message: `Invalid date value: ${row.value}`,
      });
      continue;
    }

    if (days <= EXPIRY_WINDOW_DAYS) {
      const message = `Expires on ${String(row.value).trim()} — renew now`;
      await upsertFailureAlert(supabase, row.key, "unknown", message);
      summaries.push({ key: row.key, ok: false, action: "alert", message });
      continue;
    }

    await resolveAlert(supabase, row.key);
    summaries.push({
      key: row.key,
      ok: true,
      action: "resolved",
      message: `${days} days remaining`,
    });
  }

  return summaries;
}

function parseNumeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function checkAnthropicBalance(
  supabase: ReturnType<typeof createClient>,
): Promise<CheckSummary> {
  const functionName = "anthropic-credits";
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  const thresholdRaw = await loadConfigValue(
    supabase,
    "anthropic_credits_low_threshold_usd",
    "2",
  );
  const threshold = parseNumeric(thresholdRaw) ?? 2;

  if (!apiKey) {
    const message = "Missing ANTHROPIC_API_KEY";
    await upsertFailureAlert(supabase, functionName, "unknown", message);
    return { key: functionName, ok: false, action: "alert", message };
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/organizations/billing", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (resp.status === 404) {
      console.warn("check-expiry-alerts Anthropic billing endpoint unavailable (404)");
      return {
        key: functionName,
        ok: true,
        action: "skipped",
        message: "Billing endpoint unavailable",
      };
    }

    if (!resp.ok) {
      const rawError = (await resp.text()) || `HTTP ${resp.status}`;
      console.warn("check-expiry-alerts Anthropic billing check failed", rawError);
      return {
        key: functionName,
        ok: true,
        action: "skipped",
        message: rawError.slice(0, 200),
      };
    }

    const payload = await resp.json() as Record<string, unknown>;
    const credits =
      parseNumeric(payload.credit_balance) ??
      parseNumeric(payload.credits_remaining) ??
      parseNumeric(payload.available_balance) ??
      parseNumeric(
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>).credit_balance
          : null,
      );

    if (credits == null) {
      console.warn("check-expiry-alerts Anthropic billing response missing credit balance");
      return {
        key: functionName,
        ok: true,
        action: "skipped",
        message: "Credit balance not found in response",
      };
    }

    if (credits < threshold) {
      const message = `Anthropic credits low: $${credits.toFixed(2)} (threshold $${threshold})`;
      await upsertFailureAlert(supabase, functionName, "billing", message);
      return { key: functionName, ok: false, action: "alert", message };
    }

    await resolveAlert(supabase, functionName);
    return {
      key: functionName,
      ok: true,
      action: "resolved",
      message: `$${credits.toFixed(2)} remaining`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("check-expiry-alerts Anthropic billing check error", message);
    return { key: functionName, ok: true, action: "skipped", message };
  }
}

async function checkExotelBalance(
  supabase: ReturnType<typeof createClient>,
): Promise<CheckSummary> {
  const functionName = "exotel-credits";
  const sid = Deno.env.get("EXOTEL_SID")?.trim();
  const apiKey = Deno.env.get("EXOTEL_API_KEY")?.trim();
  const apiToken = Deno.env.get("EXOTEL_API_TOKEN")?.trim();
  const thresholdRaw = await loadConfigValue(
    supabase,
    "exotel_credits_low_threshold_inr",
    "200",
  );
  const threshold = parseNumeric(thresholdRaw) ?? 200;

  if (!sid || !apiKey || !apiToken) {
    const message = "Missing Exotel credentials";
    await upsertFailureAlert(supabase, functionName, "unknown", message);
    return { key: functionName, ok: false, action: "alert", message };
  }

  try {
    const auth = btoa(`${apiKey}:${apiToken}`);
    const resp = await fetch(`https://api.exotel.com/v1/Accounts/${sid}/Balance`, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      const message = rawText || `HTTP ${resp.status}`;
      await upsertFailureAlert(supabase, functionName, "unknown", message);
      return { key: functionName, ok: false, action: "alert", message: message.slice(0, 200) };
    }

    const match = rawText.match(/<AvailableBalance>([\d.]+)<\/AvailableBalance>/i);
    const balance = match ? parseNumeric(match[1]) : null;
    if (balance == null) {
      const message = "Exotel balance not found in response";
      console.warn("check-expiry-alerts", message, rawText.slice(0, 200));
      return { key: functionName, ok: true, action: "skipped", message };
    }

    if (balance < threshold) {
      const message = `Exotel credits low: ₹${balance.toFixed(2)} (threshold ₹${threshold})`;
      await upsertFailureAlert(supabase, functionName, "billing", message);
      return { key: functionName, ok: false, action: "alert", message };
    }

    await resolveAlert(supabase, functionName);
    return {
      key: functionName,
      ok: true,
      action: "resolved",
      message: `₹${balance.toFixed(2)} remaining`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertFailureAlert(supabase, functionName, "unknown", message);
    return { key: functionName, ok: false, action: "alert", message: message.slice(0, 200) };
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
    try {
      await req.json();
    } catch {
      /* empty body is fine for cron */
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ success: false, error: "Server misconfigured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const expiryResults = await checkExpiryDates(supabase);
    const anthropicResult = await checkAnthropicBalance(supabase);
    const exotelResult = await checkExotelBalance(supabase);

    return jsonResponse({
      success: true,
      checked_at: new Date().toISOString(),
      expiry_window_days: EXPIRY_WINDOW_DAYS,
      results: [...expiryResults, anthropicResult, exotelResult],
    });
  } catch (err) {
    console.error("check-expiry-alerts failed", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
