import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Documents the silent-refetch keep-list rule for LocalFeed.fetchPosts:
 * never blank an already-populated feed on silent geo/error failure.
 */
describe("LocalFeed silent refetch keep-list rule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function shouldClearPosts(opts: {
    silent: boolean;
    existingCount: number;
    showingCached: boolean;
  }): boolean {
    const keepExisting = opts.silent && opts.existingCount > 0;
    return !(keepExisting || opts.showingCached);
  }

  it("does not clear when silent refetch fails with posts already on screen", () => {
    expect(
      shouldClearPosts({ silent: true, existingCount: 3, showingCached: false }),
    ).toBe(false);
  });

  it("clears on initial non-silent failure with no cache and no posts", () => {
    expect(
      shouldClearPosts({ silent: false, existingCount: 0, showingCached: false }),
    ).toBe(true);
  });

  it("does not clear when cache was shown", () => {
    expect(
      shouldClearPosts({ silent: false, existingCount: 0, showingCached: true }),
    ).toBe(false);
  });
});
