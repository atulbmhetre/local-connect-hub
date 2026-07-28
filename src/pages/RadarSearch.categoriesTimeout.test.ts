import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAbortSignal,
  isNetworkTimeout,
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withTimedRetry,
} from "@/lib/withNetworkRetry";

/**
 * Mirrors RadarSearch `loadCategories` CRITICAL path: a PostgREST-shaped
 * thenable that never settles must surface NetworkExhaustedError/timeout
 * instead of hanging forever.
 */
describe("Radar categories timed load (CRITICAL hang site)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out when the categories query never resolves", async () => {
    vi.useFakeTimers();

    const hangingBuilder = {
      abortSignal(_s: AbortSignal) {
        return this;
      },
      then() {
        /* never settle */
        return new Promise(() => {});
      },
    };

    const promise = withTimedRetry(
      async (signal) =>
        throwOnSupabaseNetworkError(
          await applyAbortSignal(hangingBuilder as never, signal),
        ),
      {
        timeoutMs: 200,
        maxAttempts: 2,
        baseDelayMs: 50,
        shouldRetry: () => true,
      },
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(NetworkExhaustedError);

    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(200);

    const err = await promise.catch((e: unknown) => e);
    await assertion;
    expect(isNetworkTimeout(err)).toBe(true);
  });
});
