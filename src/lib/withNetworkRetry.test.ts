import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNetworkFailure,
  NetworkExhaustedError,
  withNetworkRetry,
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

  it("returns false for an unrelated application error object", () => {
    expect(isNetworkFailure({ message: "insufficient_stock" })).toBe(false);
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
