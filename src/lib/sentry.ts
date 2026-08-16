import * as Sentry from "@sentry/capacitor";
import * as SentryReact from "@sentry/react";
import type { ErrorEvent, EventHint } from "@sentry/core";
import { getDeviceId } from "@/lib/deviceId";

const DSN =
  "https://a2f4812f5a59fecb0b02531fddfded05@o4511633087332352.ingest.us.sentry.io/4511633127178240";

/**
 * RPC / edge rejection tokens that are expected user-facing outcomes, not bugs.
 * Matched as substrings against exception message/value (case-insensitive).
 * Review before adding — over-broad tokens recreate monitoring blind spots.
 */
export const EXPECTED_USER_REJECTION_SUBSTRINGS = [
  "already_actioned",
  "amount_exceeds_outstanding",
  "appointment_slot_taken",
  "bill_already_khata",
  "bill_not_found",
  "bill_not_unpaid",
  "cannot_fulfil_without_bill",
  "category_location_review_pending",
  "category_not_found",
  "category_not_ready",
  "customer_banned",
  "customer_payment_block",
  "customer_phone_missing",
  "customer_phone_required",
  "customer_recipient_missing",
  "device_id_required",
  "identity_required",
  "invalid_phone_format",
  "invalid_rating",
  "invalid_service_location",
  "invalid_service_mode",
  "invalid_source",
  "invalid_upi_format",
  "invalid_utr_format",
  "khata_limits_invalid",
  "khata_red_limit_exceeded",
  "ledger_cycle_change_blocked",
  "ledger_not_found",
  "no_outstanding_balance",
  "no_vendor_customer_relationship",
  "not_editable_or_unauthorized",
  "not_found_or_unauthorized",
  "not_authorized",
  "order_closed",
  "order_not_fulfilled",
  "payment_not_claimed",
  "payment_screenshot_required",
  "payment_self_declare_restricted",
  "push_permission_denied",
  "rate_limit_exceeded",
  "rate_limited",
  "reader_location_required",
  "request_not_found",
  "review_already_exists",
  "review_edit_window_expired",
  "saved_vendors_limit_exceeded",
  "service_mode_not_available_for_category",
  "service_mode_unavailable",
  "unauthorised",
  "unauthorized",
  "user_phone_required",
  "vendor_banned",
  "vendor_identity_required",
  "vendor_mismatch",
  "vendor_not_discoverable",
  "vendor_not_found",
  "vendor_not_found_or_unauthorized",
  "vendor_not_live_for_asap",
  "vendor_not_live_for_instant",
  "vendor_unauthorized",
  "would_create_customer_credit",
] as const;

type SentryEnv = {
  PROD: boolean;
  VITE_ENVIRONMENT?: string;
};

/**
 * Sentry is opt-in only: both a production Vite build AND an explicit
 * VITE_ENVIRONMENT=production (set in gitignored .env.production for real APK/web releases).
 * Default everywhere else (unset, test, dev) is off — no kill-switch file required.
 */
export function resolveSentryReportingEnabled(
  env: SentryEnv,
  dsn: string = DSN,
): boolean {
  if (!dsn.trim()) return false;
  if (env.VITE_ENVIRONMENT !== "production") return false;
  if (!env.PROD) return false;
  return true;
}

function readViteSentryEnv(): SentryEnv {
  try {
    const env = import.meta?.env;
    if (env) {
      return {
        PROD: Boolean(env.PROD),
        VITE_ENVIRONMENT: env.VITE_ENVIRONMENT as string | undefined,
      };
    }
  } catch {
    /* Playwright/node collectors may load this module outside Vite. */
  }
  return { PROD: false, VITE_ENVIRONMENT: undefined };
}

const SENTRY_REPORTING_ENABLED = resolveSentryReportingEnabled(readViteSentryEnv());

export function isSentryReportingEnabled(): boolean {
  return SENTRY_REPORTING_ENABLED;
}

export function phoneSuffix(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : trimmed;
}

type PostgrestLikeError = {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/** Normalize Supabase/PostgREST plain objects into real Error instances for Sentry. */
export function toCapturedError(error: unknown): Error {
  if (error instanceof Error) return error;

  if (typeof error === "object" && error !== null && "message" in error) {
    const pg = error as PostgrestLikeError;
    const message = String(pg.message ?? "Unknown error").trim() || "Unknown error";
    const code = pg.code ? String(pg.code) : "";
    const wrapped = new Error(code ? `${message} (${code})` : message);
    return wrapped;
  }

  if (typeof error === "string" && error.trim()) {
    return new Error(error.trim());
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown error");
  }
}

type SentryErrorLike = {
  message?: string;
  exception?: {
    values?: Array<{ type?: string; value?: string }>;
  };
};

function collectEventText(event: SentryErrorLike, hint?: EventHint): string {
  const chunks: string[] = [];
  if (event.message) chunks.push(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.type) chunks.push(ex.type);
    if (ex.value) chunks.push(ex.value);
  }
  const original = hint?.originalException;
  if (original instanceof Error) {
    chunks.push(original.message);
    if (original.name) chunks.push(original.name);
  } else if (typeof original === "string") {
    chunks.push(original);
  }
  return chunks.join(" | ").toLowerCase();
}

export function isExpectedUserFacingRejection(
  event: SentryErrorLike,
  hint?: EventHint,
): boolean {
  const haystack = collectEventText(event, hint);
  if (!haystack) return false;
  return EXPECTED_USER_REJECTION_SUBSTRINGS.some((token) => haystack.includes(token));
}

export function beforeSendSentryEvent(
  event: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  if (isExpectedUserFacingRejection(event, hint)) return null;
  return event;
}

export function initSentry(): void {
  if (!SENTRY_REPORTING_ENABLED) return;

  Sentry.init(
    {
      dsn: DSN,
      enabled: true,
      environment: "production",
      tracesSampleRate: 0.2,
      integrations: [Sentry.browserTracingIntegration()],
      beforeSend: beforeSendSentryEvent,
    },
    SentryReact.init,
  );

  try {
    Sentry.setUser({ id: getDeviceId() });
  } catch {
    /* ignore — anonymous correlation is best-effort */
  }
}

export function addBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!SENTRY_REPORTING_ENABLED) return;

  Sentry.addBreadcrumb({
    category: "app",
    message,
    data,
    level: "info",
  });
}

export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!SENTRY_REPORTING_ENABLED) return;
  if (
    isExpectedUserFacingRejection({
      exception: { values: [{ value: toCapturedError(error).message }] },
    })
  ) {
    return;
  }

  Sentry.captureException(
    toCapturedError(error),
    context
      ? {
          extra: {
            ...context,
            rawError: error,
          },
        }
      : { extra: { rawError: error } },
  );
}
