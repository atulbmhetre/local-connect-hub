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

export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof NetworkExhaustedError) return true;
  if (error instanceof TypeError) return true;

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
      msg.includes("load failed")
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
