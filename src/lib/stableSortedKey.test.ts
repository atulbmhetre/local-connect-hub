import { describe, expect, it } from "vitest";
import { shouldSkipBackupPoll, stableSortedKey } from "./stableSortedKey";

describe("stableSortedKey", () => {
  it("is identical for the same ids in any order or with duplicates", () => {
    expect(stableSortedKey(["b", "a", "b"])).toBe(stableSortedKey(["a", "b"]));
    expect(stableSortedKey(["a", "b"])).toBe("a,b");
  });

  it("changes when the set of ids changes", () => {
    expect(stableSortedKey(["a", "b"])).not.toBe(stableSortedKey(["a", "c"]));
    expect(stableSortedKey([])).toBe("");
  });
});

describe("shouldSkipBackupPoll", () => {
  it("skips when Realtime delivered within the window", () => {
    expect(shouldSkipBackupPoll(10_000, 30_000)).toBe(true);
    expect(shouldSkipBackupPoll(10_000, 34_999)).toBe(true);
  });

  it("does not skip when Realtime is stale or never fired", () => {
    expect(shouldSkipBackupPoll(10_000, 35_000)).toBe(false);
    expect(shouldSkipBackupPoll(0, 30_000)).toBe(false);
  });
});
