import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNetworkFailure,
  isNetworkTimeout,
  NetworkExhaustedError,
  NetworkTimeoutError,
  withNetworkRetry,
  withTimedRetry,
} from "@/lib/withNetworkRetry";

describe("isNetworkFailure", () => {
  it("returns true for Supabase-style plain object with Failed to fetch message", () => {
    expect(
      isNetworkFailure({
        message: "TypeError: Failed to fetch (hhdylnhqdzfabsolwxdz.supabase.co)",
      }),
    ).toBe(true);
  });

  it("returns true for a real TypeError", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("returns true for NetworkExhaustedError", () => {
    expect(isNetworkFailure(new NetworkExhaustedError())).toBe(true);
  });

  it("returns true for NetworkTimeoutError", () => {
    expect(isNetworkFailure(new NetworkTimeoutError())).toBe(true);
  });

  it("returns false for an unrelated application error object", () => {
    expect(isNetworkFailure({ message: "insufficient_stock" })).toBe(false);
  });
});

describe("isNetworkTimeout", () => {
  it("detects NetworkTimeoutError and exhausted-with-timeout-cause", () => {
    expect(isNetworkTimeout(new NetworkTimeoutError())).toBe(true);
    expect(isNetworkTimeout(new NetworkExhaustedError(new NetworkTimeoutError()))).toBe(
      true,
    );
    expect(isNetworkTimeout(new NetworkExhaustedError(new TypeError("Failed to fetch")))).toBe(
      false,
    );
  });
});

describe("withNetworkRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on network-classified failure and eventually resolves", async () => {
    vi.useFakeTimers();
    const onRetrying = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("TypeError: Failed to fetch (example.supabase.co)");
      }
      return "ok";
    });

    const promise = withNetworkRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      shouldRetry: () => true,
      onRetrying,
    });
    const assertion = expect(promise).resolves.toBe("ok");

    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetrying).toHaveBeenCalledTimes(2);
    expect(onRetrying).toHaveBeenNthCalledWith(1, 1);
    expect(onRetrying).toHaveBeenNthCalledWith(2, 2);
  });

  it("does not retry when fn resolves with a non-network Supabase error", async () => {
    const result = { data: null, error: { message: "some_app_error" } };
    const fn = vi.fn(async () => result);

    await expect(withNetworkRetry(fn)).resolves.toBe(result);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws NetworkExhaustedError after maxAttempts exhausted", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error("TypeError: Failed to fetch (example.supabase.co)");
    });

    const promise = withNetworkRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      shouldRetry: () => true,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(NetworkExhaustedError);

    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws NetworkExhaustedError immediately when shouldRetry returns false", async () => {
    vi.useFakeTimers();
    const onRetrying = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error("TypeError: Failed to fetch (example.supabase.co)");
    });

    const promise = withNetworkRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 1000,
      shouldRetry: () => false,
      onRetrying,
    });

    await expect(promise).rejects.toBeInstanceOf(NetworkExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetrying).not.toHaveBeenCalled();
  });
});

describe("withTimedRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when fn completes before timeout", async () => {
    const result = await withTimedRetry(
      async () => "ok",
      { timeoutMs: 5_000, maxAttempts: 2, shouldRetry: () => true },
    );
    expect(result).toBe("ok");
  });

  it("times out a promise that never resolves (simulated hang)", async () => {
    vi.useFakeTimers();
    const onRetrying = vi.fn();
    const fn = vi.fn((_signal: AbortSignal) => new Promise<string>(() => {}));

    const promise = withTimedRetry(fn, {
      timeoutMs: 1_000,
      maxAttempts: 2,
      baseDelayMs: 100,
      shouldRetry: () => true,
      onRetrying,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(NetworkExhaustedError);

    // Attempt 1: hang until timeout
    await vi.advanceTimersByTimeAsync(1_000);
    // Backoff
    await vi.advanceTimersByTimeAsync(100);
    // Attempt 2: hang until timeout
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await promise.catch((e: unknown) => e);
    await assertion;
    expect(err).toBeInstanceOf(NetworkExhaustedError);
    expect(isNetworkTimeout(err)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetrying).toHaveBeenCalledTimes(1);
  });

  it("aborts the signal when the attempt times out", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | null = null;
    const fn = vi.fn((signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<string>(() => {});
    });

    const promise = withTimedRetry(fn, {
      timeoutMs: 500,
      maxAttempts: 1,
      shouldRetry: () => false,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(NetworkExhaustedError);

    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  });

  it("retries after timeout then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async (_signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string>(() => {});
      }
      return "recovered";
    });

    const promise = withTimedRetry(fn, {
      timeoutMs: 200,
      maxAttempts: 3,
      baseDelayMs: 50,
      shouldRetry: () => true,
    });

    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("maps fetch AbortError to NetworkTimeoutError then exhausts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    const promise = withTimedRetry(fn, {
      timeoutMs: 10_000,
      maxAttempts: 1,
      shouldRetry: () => false,
    });

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof NetworkExhaustedError && isNetworkTimeout(err),
    );
  });
});
