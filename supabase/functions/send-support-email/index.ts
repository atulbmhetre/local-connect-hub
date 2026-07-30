/**
 * send-support-email — Help & Support Feedback / Contact Support.
 *
 * Persists the submission, then emails support@aaspaaspro.com via Zoho SMTP.
 * Does NOT write to the admin notification inbox (Contact Support triggers
 * invokeNotifyAdmin separately on the client).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@9";
import { clientIp } from "../_shared/rateLimitUtils.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const SUPPORT_TO = "support@aaspaaspro.com";
const SMTP_TIMEOUT_MS = 15_000;
const KINDS = new Set(["feedback", "contact"]);
const CONTACT_CATEGORIES = new Set([
  "payment",
  "account",
  "order",
  "vendor",
  "other",
]);

type RequestBody = {
  kind?: string;
  category?: string | null;
  rating?: number | null;
  message?: string;
  user_phone?: string | null;
  vendor_id?: string | null;
  device_id?: string | null;
  healthCheck?: boolean;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function truncate(raw: string, max: number): string {
  const t = raw.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  identifierType: "device_id" | "ip" | "phone",
  identifier: string,
): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("check_and_log_rate_limit", {
    p_function_name: "send-support-email",
    p_identifier_type: identifierType,
    p_identifier: identifier,
    p_max_requests: 8,
    p_window_seconds: 300,
  });
  if (error) {
    console.error("send-support-email rate limit RPC failed", identifierType, error);
    return null;
  }
  return data === true;
}

function readZohoSmtpConfig():
  | { host: string; port: number; user: string; pass: string }
  | { error: string } {
  const host = Deno.env.get("Zoho_SMTP_HOST")?.trim();
  const portRaw = Deno.env.get("Zoho_SMTP_PORT")?.trim();
  const user = Deno.env.get("Zoho_SMTP_USER")?.trim();
  const pass = Deno.env.get("Zoho_SMTP_PASS")?.trim();

  if (!host || !portRaw || !user || !pass) {
    return { error: "email_not_configured" };
  }

  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { error: "smtp_invalid_port" };
  }

  return { host, port, user, pass };
}

async function sendViaZohoSmtp(opts: {
  subject: string;
  text: string;
}): Promise<{ sent: boolean; error?: string }> {
  const config = readZohoSmtpConfig();
  if ("error" in config) {
    return { sent: false, error: config.error };
  }

  const { host, port, user, pass } = config;
  // Zoho requires the From address to match the authenticated mailbox.
  const from = `AasPaas Pro <${user}>`;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        transport.sendMail(
          {
            from,
            to: SUPPORT_TO,
            subject: opts.subject,
            text: opts.text,
          },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      }),
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error(`smtp_timeout_${SMTP_TIMEOUT_MS}ms`)),
          SMTP_TIMEOUT_MS,
        );
      }),
    ]);
    return { sent: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("send-support-email Zoho SMTP failed", detail);
    return { sent: false, error: `smtp_failed:${truncate(detail, 120)}` };
  } finally {
    transport.close();
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let parsed: RequestBody = {};
  try {
    const text = await req.text();
    if (text?.trim()) parsed = JSON.parse(text) as RequestBody;
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (parsed.healthCheck === true) {
    return jsonResponse({ ok: true, healthy: true });
  }

  const kind = String(parsed.kind ?? "").trim().toLowerCase();
  if (!KINDS.has(kind)) {
    return jsonResponse({ ok: false, error: "invalid_kind" }, 400);
  }

  const message = String(parsed.message ?? "").trim();
  if (message.length < 3) {
    return jsonResponse({ ok: false, error: "message_required" }, 400);
  }
  if (message.length > 4000) {
    return jsonResponse({ ok: false, error: "message_too_long" }, 400);
  }

  let category: string | null = null;
  if (kind === "contact") {
    category = String(parsed.category ?? "").trim().toLowerCase();
    if (!CONTACT_CATEGORIES.has(category)) {
      return jsonResponse({ ok: false, error: "invalid_category" }, 400);
    }
  }

  let rating: number | null = null;
  if (kind === "feedback" && parsed.rating != null) {
    const n = Number(parsed.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return jsonResponse({ ok: false, error: "invalid_rating" }, 400);
    }
    rating = n;
  }

  const userPhone = String(parsed.user_phone ?? "").replace(/[\s\-+]/g, "").trim() || null;
  const rawVendorId = String(parsed.vendor_id ?? "").trim();
  const vendorId =
    rawVendorId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawVendorId)
      ? rawVendorId
      : null;
  const deviceId = String(parsed.device_id ?? "").trim() || null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const ip = clientIp(req) ?? "unknown";
  const rlKey = userPhone || deviceId || ip;
  const rlType = userPhone ? "phone" : deviceId ? "device_id" : "ip";
  const allowed = await checkRateLimit(supabase, rlType, rlKey);
  if (allowed === false) {
    return jsonResponse({ ok: false, error: "rate_limited" }, 429);
  }

  const subject =
    kind === "feedback"
      ? `[Feedback]${rating ? ` ${rating}★` : ""} AasPaas Pro`
      : `[Support] ${category?.toUpperCase() ?? "OTHER"} — AasPaas Pro`;

  const textLines = [
    `Kind: ${kind}`,
    category ? `Category: ${category}` : null,
    rating != null ? `Rating: ${rating}/5` : null,
    userPhone ? `Phone: ${userPhone}` : "Phone: (none)",
    vendorId ? `Vendor ID: ${vendorId}` : "Vendor ID: (none)",
    deviceId ? `Device: ${deviceId}` : null,
    "",
    "Message:",
    message,
  ].filter((line): line is string => line != null);

  const emailResult = await sendViaZohoSmtp({
    subject,
    text: textLines.join("\n"),
  });

  const { data: row, error: insertError } = await supabase
    .from("support_messages")
    .insert({
      kind,
      category,
      rating,
      message: truncate(message, 4000),
      user_phone: userPhone,
      vendor_id: vendorId,
      device_id: deviceId,
      email_sent: emailResult.sent,
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    console.error("send-support-email insert failed", insertError);
    if (emailResult.sent) {
      return jsonResponse({
        ok: true,
        emailed: true,
        id: null,
        warn: "persisted_failed",
      });
    }
    return jsonResponse({ ok: false, error: "persist_failed" }, 500);
  }

  return jsonResponse({
    ok: true,
    emailed: emailResult.sent,
    id: row?.id ?? null,
    email_error: emailResult.sent ? null : emailResult.error ?? null,
  });
});
