import * as Sentry from "@sentry/capacitor";
import * as SentryReact from "@sentry/react";

const DSN =
  "https://a2f4812f5a59fecb0b02531fddfded05@o4511633087332352.ingest.us.sentry.io/4511633127178240";

const SENTRY_ENABLED = DSN.length > 0;

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

export function initSentry(): void {
  if (!SENTRY_ENABLED) return;

  Sentry.init(
    {
      dsn: DSN,
      enabled: true,
      environment: import.meta.env.VITE_ENVIRONMENT ?? "production",
      tracesSampleRate: 0.2,
      integrations: [Sentry.browserTracingIntegration()],
    },
    SentryReact.init,
  );
}

export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!SENTRY_ENABLED) return;

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
