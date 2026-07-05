import { describe, expect, it } from "vitest";
import { clientIp } from "./rateLimitUtils";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com", { headers });
}

describe("clientIp", () => {
  it("returns the first IP when x-forwarded-for has multiple comma-separated values", () => {
    expect(clientIp(makeRequest({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("trims whitespace around the first IP", () => {
    expect(clientIp(makeRequest({ "x-forwarded-for": "  9.9.9.9  ,10.10.10.10" }))).toBe("9.9.9.9");
  });

  it("returns 'unknown' when header is missing", () => {
    expect(clientIp(makeRequest({}))).toBe("unknown");
  });

  it("returns 'unknown' when header is present but empty", () => {
    expect(clientIp(makeRequest({ "x-forwarded-for": "" }))).toBe("unknown");
  });

  it("returns single IP unchanged when only one value present", () => {
    expect(clientIp(makeRequest({ "x-forwarded-for": "8.8.8.8" }))).toBe("8.8.8.8");
  });
});
