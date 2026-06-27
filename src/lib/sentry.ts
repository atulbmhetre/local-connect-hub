import * as Sentry from "@sentry/capacitor";
import * as SentryReact from "@sentry/react";

const DSN =
  "https://a2f4812f5a59fecb0b02531fddfded05@o4511633087332352.ingest.us.sentry.io/4511633127178240";

const SENTRY_ENABLED = DSN.length > 0;

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
    error,
    context ? { extra: context } : undefined,
  );
}
