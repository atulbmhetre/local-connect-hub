import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPECTED_USER_REJECTION_SUBSTRINGS,
  beforeSendSentryEvent,
  captureError,
  isExpectedUserFacingRejection,
  isSentryReportingEnabled,
  phoneSuffix,
  resolveSentryReportingEnabled,
  toCapturedError,
} from "@/lib/sentry";

describe("resolveSentryReportingEnabled", () => {
  const prodReleaseEnv = {
    PROD: true,
    VITE_ENVIRONMENT: "production",
  } as const;

  it("enables only for production builds with explicit production environment", () => {
    expect(resolveSentryReportingEnabled(prodReleaseEnv)).toBe(true);
  });

  it("defaults off when VITE_ENVIRONMENT is unset", () => {
    expect(
      resolveSentryReportingEnabled({
        PROD: true,
        VITE_ENVIRONMENT: undefined,
      }),
    ).toBe(false);
  });

  it("disables for TEST environment even on production builds", () => {
    expect(
      resolveSentryReportingEnabled({
        ...prodReleaseEnv,
        VITE_ENVIRONMENT: "test",
      }),
    ).toBe(false);
  });

  it("disables for vite dev server even when environment tag is production", () => {
    expect(
      resolveSentryReportingEnabled({
        PROD: false,
        VITE_ENVIRONMENT: "production",
      }),
    ).toBe(false);
  });
});

describe("isSentryReportingEnabled in vitest", () => {
  it("is false under the vitest runner", () => {
    expect(isSentryReportingEnabled()).toBe(false);
  });
});

describe("toCapturedError", () => {
  it("wraps PostgREST error objects with readable messages", () => {
    const err = toCapturedError({
      code: "P0001",
      details: null,
      hint: null,
      message: "not_found_or_unauthorized",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("not_found_or_unauthorized (P0001)");
  });

  it("passes through Error instances unchanged", () => {
    const original = new Error("already wrapped");
    expect(toCapturedError(original)).toBe(original);
  });
});

describe("phoneSuffix", () => {
  it("returns last four digits for longer phones", () => {
    expect(phoneSuffix("9876543210")).toBe("3210");
  });

  it("returns the full trimmed value when shorter than four digits", () => {
    expect(phoneSuffix("123")).toBe("123");
  });
});

describe("expected user-facing rejection filter", () => {
  it("drops known RPC rejection tokens via beforeSend", () => {
    const event = {
      type: undefined,
      exception: {
        values: [{ value: "payment_self_declare_restricted (P0001)" }],
      },
    } as import("@sentry/core").ErrorEvent;
    expect(isExpectedUserFacingRejection(event)).toBe(true);
    expect(beforeSendSentryEvent(event)).toBeNull();
  });

  it("keeps unexpected failures", () => {
    const event = {
      type: undefined,
      exception: {
        values: [{ value: "TypeError: Cannot read properties of undefined" }],
      },
    } as import("@sentry/core").ErrorEvent;
    expect(isExpectedUserFacingRejection(event)).toBe(false);
    expect(beforeSendSentryEvent(event)).toEqual(event);
  });

  it("keeps internal config failures out of the filter list", () => {
    const event = {
      type: undefined,
      exception: {
        values: [
          {
            value:
              "app_config key help_accept_timeout_minutes is missing or invalid",
          },
        ],
      },
    } as import("@sentry/core").ErrorEvent;
    expect(EXPECTED_USER_REJECTION_SUBSTRINGS).not.toContain(
      "app_config key help_accept_timeout_minutes is missing or invalid",
    );
    expect(beforeSendSentryEvent(event)).toEqual(event);
  });
});

describe("ingest isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call Sentry.init under vitest", async () => {
    const init = vi.fn();
    vi.doMock("@sentry/capacitor", () => ({
      init,
      browserTracingIntegration: vi.fn(),
      setUser: vi.fn(),
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
    }));
    vi.resetModules();
    const { initSentry } = await import("@/lib/sentry");
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  it("captureError is a no-op under vitest (no ingest fetch)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    captureError(new Error("test leak should not report"));
    expect(isSentryReportingEnabled()).toBe(false);
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).includes("ingest.us.sentry.io")),
    ).toBe(false);
  });
});
