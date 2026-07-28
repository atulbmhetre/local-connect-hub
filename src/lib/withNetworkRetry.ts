import { getNavigatorOnline } from "@/hooks/useNetworkStatus";

/** Thrown when all network retries are exhausted (distinct from application/Supabase errors). */
export class NetworkExhaustedError extends Error {
  readonly kind = "network_exhausted" as const;

  constructor(cause?: unknown) {
    super("Network retries exhausted");
    this.name = "NetworkExhaustedError";
    this.cause = cause;
  }
}

/**
 * Thrown when a single attempt exceeds `timeoutMs` (or the underlying fetch
 * aborts because we cancelled it). Distinct so UI can show a slow-connection
 * message instead of a generic failure.
 */
export class NetworkTimeoutError extends Error {
  readonly kind = "network_timeout" as const;

  constructor(cause?: unknown) {
    super("Network request timed out");
    this.name = "NetworkTimeoutError";
    this.cause = cause;
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof NetworkTimeoutError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function isNetworkTimeout(error: unknown): boolean {
  if (error instanceof NetworkTimeoutError) return true;
  if (error instanceof NetworkExhaustedError) {
    return isNetworkTimeout(error.cause);
  }
  if (isAbortError(error)) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : null;
  if (message) {
    const msg = message.toLowerCase();
    if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("aborted")) {
      return true;
    }
  }
  return false;
}

export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof NetworkExhaustedError) return true;
  if (error instanceof NetworkTimeoutError) return true;
  if (error instanceof TypeError) return true;
  if (isAbortError(error)) return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : null;

  if (message) {
    const msg = message.toLowerCase();
    if (
      msg.includes("failed to fetch") ||
      msg.includes("networkerror") ||
      msg.includes("network request failed") ||
      msg.includes("load failed") ||
      msg.includes("timed out") ||
      msg.includes("network request timed out") ||
      msg.includes("aborted")
    ) {
      return true;
    }
  }
  return false;
}

type SupabaseResult = { error: unknown | null };

/**
 * Supabase-js usually rejects when fetch throws, but some failures surface as
 * `{ data: null, error }`. Re-throw those so withNetworkRetry can retry them.
 */
export function throwOnSupabaseNetworkError<T extends SupabaseResult>(result: T): T {
  if (result.error && isNetworkFailure(result.error)) {
    const message =
      result.error instanceof Error
        ? result.error.message
        : typeof result.error === "object" &&
            result.error !== null &&
            "message" in result.error
          ? String((result.error as { message: unknown }).message)
          : "Network request failed";
    throw new Error(message || "Network request failed");
  }
  return result;
}

/**
 * Attach AbortSignal to a PostgREST builder when the client supports it.
 * Safe no-op on older builders — `withTimedRetry` still races the timeout.
 */
export function applyAbortSignal<Q>(query: Q, signal: AbortSignal): Q {
  const q = query as Q & { abortSignal?: (s: AbortSignal) => Q };
  if (typeof q.abortSignal === "function") {
    return q.abortSignal(signal);
  }
  return query;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WithNetworkRetryOptions = {
  /** Total attempts including the first try. Default 4 (= 1 initial + 3 retries). */
  maxAttempts?: number;
  /** Base delay before the 2nd attempt; doubles each retry (1s, 2s, 4s). */
  baseDelayMs?: number;
  /** Fired before each retry wait; `attempt` is 1-based retry index. */
  onRetrying?: (attempt: number) => void;
  /**
   * Return false to stop retrying early. Defaults to `getNavigatorOnline()`.
   * We still always attempt at least once — `navigator.onLine` can lie on mobile,
   * so we only consult it after a failure to avoid wasting backoff when clearly offline.
   */
  shouldRetry?: () => boolean;
};

/**
 * Retries `fn` only when it throws/rejects with a network-style failure.
 * Normal resolution (including Supabase `{ data, error }` with `error` set) is
 * returned as-is — those are application errors and are never retried.
 *
 * Does **not** add a per-attempt timeout — prefer `withTimedRetry` for
 * user-blocking flows that can hang on slow/lossy networks.
 */
export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  options: WithNetworkRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const shouldRetry = options.shouldRetry ?? getNavigatorOnline;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isNetworkFailure(err)) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        throw new NetworkExhaustedError(err);
      }

      if (!shouldRetry()) {
        throw new NetworkExhaustedError(err);
      }

      options.onRetrying?.(attempt);
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }
  }

  throw new NetworkExhaustedError(lastError);
}

export type WithTimedRetryOptions = WithNetworkRetryOptions & {
  /**
   * Per-attempt wall-clock budget. Default 12s — long enough for typical
   * Supabase RPC on mid/poor 4G (often 1–5s p95), short enough that a hung
   * TCP stall surfaces before the user assumes the app is frozen.
   * Total worst-case with defaults: ~12 + 1 + 12 + 2 + 12 ≈ 39s.
   */
  timeoutMs?: number;
};

/** Default per-attempt timeout for CRITICAL mobile RPCs (4G-aware). */
export const DEFAULT_NETWORK_TIMEOUT_MS = 12_000;

/**
 * Like `withNetworkRetry`, but each attempt is bounded by AbortController +
 * Promise race. Use this for CRITICAL user-blocking calls (restore, radar,
 * registration follow-ons, find-account) where a never-resolving fetch would
 * otherwise leave an infinite spinner.
 *
 * `fn` receives the attempt's AbortSignal — pass it to `fetch` / PostgREST
 * via `applyAbortSignal` when possible. Even if the underlying client ignores
 * abort, the race still rejects with `NetworkTimeoutError` when the budget
 * expires.
 */
export async function withTimedRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: WithTimedRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  const shouldRetry = options.shouldRetry ?? getNavigatorOnline;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const result = await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          reject(new NetworkTimeoutError());
        };

        if (controller.signal.aborted) {
          onAbort();
          return;
        }

        controller.signal.addEventListener("abort", onAbort, { once: true });

        void fn(controller.signal).then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            if (timedOut || controller.signal.aborted) {
              reject(new NetworkTimeoutError());
              return;
            }
            resolve(value);
          },
          (err: unknown) => {
            controller.signal.removeEventListener("abort", onAbort);
            if (timedOut || isAbortError(err)) {
              reject(new NetworkTimeoutError(err));
              return;
            }
            reject(err);
          },
        );
      });

      return result;
    } catch (err) {
      lastError = err;

      if (!isNetworkFailure(err)) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        throw new NetworkExhaustedError(err);
      }

      if (!shouldRetry()) {
        throw new NetworkExhaustedError(err);
      }

      options.onRetrying?.(attempt);
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new NetworkExhaustedError(lastError);
}
