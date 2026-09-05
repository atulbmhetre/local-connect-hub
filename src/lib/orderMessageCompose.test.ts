import { describe, expect, it } from "vitest";
import { composeOrderMessageForRpc } from "@/lib/orderMessageCompose";

describe("composeOrderMessageForRpc (M1)", () => {
  it("leaves room for locationNote so the combined string never exceeds max", () => {
    const note = "\n[Come to me]";
    const max = 20;
    const base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const combined = composeOrderMessageForRpc(base, note, max);
    expect(combined.length).toBeLessThanOrEqual(max);
    expect(combined.endsWith(note)).toBe(true);
  });

  it("keeps the full base when note fits under the max", () => {
    expect(composeOrderMessageForRpc("hello", "!", 10)).toBe("hello!");
  });

  it("allows an empty note without changing truncation behavior", () => {
    expect(composeOrderMessageForRpc("abcdefghij", "", 5)).toBe("abcde");
  });
});
