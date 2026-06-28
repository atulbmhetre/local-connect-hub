import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const FETCH_TIMEOUT_MS = 30_000;
const EXTERNAL_FETCH_TIMEOUT_MS = 10_000;

type ErrorType = "billing" | "model" | "timeout" | "unknown";

type Target = {
  function_name: string;
  body: Record<string, unknown>;
};

const TARGETS: Target[] = [
  { function_name: "suggest-category", body: { description: "health-check" } },
  {
    function_name: "parse-image-bill",
    body: { imageBase64: "", healthCheck: true },
  },
  {
    function_name: "parse-image-order",
    body: { imageBase64: "", healthCheck: true },
  },
  {
    function_name: "process-new-category",
    body: { label: "health-check", healthCheck: true },
  },
];

type CheckResult = {
  function_name: string;
  ok: boolean;
  status?: number;
  error_type?: ErrorType;
  error?: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function detectErrorType(rawError: string, timedOut: boolean): ErrorType {
  if (timedOut) return "timeout";
  const lower = rawError.toLowerCase();
  if (lower.includes("credit balance")) return "billing";
  if (lower.includes("model") || lower.includes("deprecated")) return "model";
  return "unknown";
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

async function pingTarget(
  supabaseUrl: string,
  serviceRoleKey: string,
  supabase: ReturnType<typeof createClient>,
  target: Target,
): Promise<CheckResult> {
  const url = `${supabaseUrl}/functions/v1/${target.function_name}`;
  let timedOut = false;
  let status: number | undefined;
  let rawError = "";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(target.body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    status = resp.status;
    rawError = await resp.text();

    if (resp.ok) {
      await resolveAlert(supabase, target.function_name);
      return {
        function_name: target.function_name,
        ok: true,
        status,
      };
    }

    const errorType = detectErrorType(rawError, false);
    await upsertFailureAlert(
      supabase,
      target.function_name,
      errorType,
      rawError || `HTTP ${status}`,
    );
    return {
      function_name: target.function_name,
      ok: false,
      status,
      error_type: errorType,
      error: rawError.slice(0, 200) || `HTTP ${status}`,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      timedOut = true;
    } else if (err instanceof Error && err.name === "AbortError") {
      timedOut = true;
    }
    rawError = err instanceof Error ? err.message : String(err);
    const errorType = detectErrorType(rawError, timedOut);
    await upsertFailureAlert(
      supabase,
      target.function_name,
      errorType,
      rawError,
    );
    return {
      function_name: target.function_name,
      ok: false,
      error_type: errorType,
      error: rawError.slice(0, 200),
    };
  }
}

async function checkExotel(
  supabase: ReturnType<typeof createClient>,
): Promise<CheckResult> {
  const functionName = "exotel-api";
  const sid = Deno.env.get("EXOTEL_SID")?.trim();
  const apiKey = Deno.env.get("EXOTEL_API_KEY")?.trim();
  const apiToken = Deno.env.get("EXOTEL_API_TOKEN")?.trim();

  if (!sid || !apiKey || !apiToken) {
    const msg = "Missing Exotel credentials (EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN)";
    await upsertFailureAlert(supabase, functionName, "unknown", msg);
    return {
      function_name: functionName,
      ok: false,
      error_type: "unknown",
      error: msg,
    };
  }

  try {
    const auth = btoa(`${apiKey}:${apiToken}`);
    const resp = await fetch(`https://api.exotel.com/v1/Accounts/${sid}/`, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });

    if (resp.status === 200 || resp.status === 401) {
      await resolveAlert(supabase, functionName);
      return { function_name: functionName, ok: true, status: resp.status };
    }

    if (resp.status >= 500) {
      const rawError = (await resp.text()) || `HTTP ${resp.status}`;
      await upsertFailureAlert(supabase, functionName, "unknown", rawError);
      return {
        function_name: functionName,
        ok: false,
        status: resp.status,
        error_type: "unknown",
        error: rawError.slice(0, 200),
      };
    }

    const rawError = (await resp.text()) || `HTTP ${resp.status}`;
    return {
      function_name: functionName,
      ok: false,
      status: resp.status,
      error_type: "unknown",
      error: rawError.slice(0, 200),
    };
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    await upsertFailureAlert(supabase, functionName, "unknown", rawError);
    return {
      function_name: functionName,
      ok: false,
      error_type: "unknown",
      error: rawError.slice(0, 200),
    };
  }
}

async function checkRazorpay(
  supabase: ReturnType<typeof createClient>,
): Promise<CheckResult> {
  const functionName = "razorpay-api";
  const keyId = Deno.env.get("RAZORPAY_KEY_ID")?.trim();
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET")?.trim();

  if (!keyId || !keySecret) {
    const msg = "Missing Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)";
    await upsertFailureAlert(supabase, functionName, "unknown", msg);
    return {
      function_name: functionName,
      ok: false,
      error_type: "unknown",
      error: msg,
    };
  }

  try {
    const auth = btoa(`${keyId}:${keySecret}`);
    const resp = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });

    if (resp.status === 200 || resp.status === 401) {
      await resolveAlert(supabase, functionName);
      return { function_name: functionName, ok: true, status: resp.status };
    }

    if (resp.status >= 500) {
      const rawError = (await resp.text()) || `HTTP ${resp.status}`;
      await upsertFailureAlert(supabase, functionName, "unknown", rawError);
      return {
        function_name: functionName,
        ok: false,
        status: resp.status,
        error_type: "unknown",
        error: rawError.slice(0, 200),
      };
    }

    const rawError = (await resp.text()) || `HTTP ${resp.status}`;
    return {
      function_name: functionName,
      ok: false,
      status: resp.status,
      error_type: "unknown",
      error: rawError.slice(0, 200),
    };
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    await upsertFailureAlert(supabase, functionName, "unknown", rawError);
    return {
      function_name: functionName,
      ok: false,
      error_type: "unknown",
      error: rawError.slice(0, 200),
    };
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
    const results: CheckResult[] = [];

    for (const target of TARGETS) {
      results.push(await pingTarget(supabaseUrl, serviceRoleKey, supabase, target));
    }

    results.push(await checkExotel(supabase));
    results.push(await checkRazorpay(supabase));

    return jsonResponse({
      success: true,
      checked_at: new Date().toISOString(),
      results,
    });
  } catch (err) {
    console.error("health-check-edge-functions failed", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
