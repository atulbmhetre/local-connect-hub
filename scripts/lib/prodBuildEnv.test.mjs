import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROD_SUPABASE_PROJECT_REF,
  PROD_SUPABASE_URL,
  assertProdBuildEnv,
  loadEffectiveProductionEnv,
  validateProdBuildEnv,
} from "./prodBuildEnv.mjs";

describe("validateProdBuildEnv", () => {
  it("accepts PROD supabase URL and production environment", () => {
    expect(
      validateProdBuildEnv({
        VITE_SUPABASE_URL: PROD_SUPABASE_URL,
        VITE_ENVIRONMENT: "production",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects TEST supabase project ref", () => {
    const result = validateProdBuildEnv({
      VITE_SUPABASE_URL: "https://hhdylnhqdzfabsolwxdz.supabase.co",
      VITE_ENVIRONMENT: "production",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(PROD_SUPABASE_PROJECT_REF);
  });

  it("rejects non-production VITE_ENVIRONMENT", () => {
    const result = validateProdBuildEnv({
      VITE_SUPABASE_URL: PROD_SUPABASE_URL,
      VITE_ENVIRONMENT: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("VITE_ENVIRONMENT");
  });

  it("rejects missing supabase URL", () => {
    const result = validateProdBuildEnv({
      VITE_ENVIRONMENT: "production",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("VITE_SUPABASE_URL");
  });
});

describe("loadEffectiveProductionEnv", () => {
  it("lets process.env override .env.production file values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-env-"));
    const file = path.join(dir, ".env.production");
    fs.writeFileSync(
      file,
      "VITE_ENVIRONMENT=test\nVITE_SUPABASE_URL=https://hhdylnhqdzfabsolwxdz.supabase.co\n",
      "utf8",
    );
    const env = loadEffectiveProductionEnv(
      {
        VITE_SUPABASE_URL: PROD_SUPABASE_URL,
        VITE_ENVIRONMENT: "production",
      },
      file,
    );
    expect(env.VITE_ENVIRONMENT).toBe("production");
    expect(env.VITE_SUPABASE_URL).toBe(PROD_SUPABASE_URL);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("assertProdBuildEnv", () => {
  it("does not exit when exit=false and env is invalid", () => {
    const result = assertProdBuildEnv(
      {
        VITE_SUPABASE_URL: "https://hhdylnhqdzfabsolwxdz.supabase.co",
        VITE_ENVIRONMENT: "test",
      },
      { exit: false },
    );
    expect(result.ok).toBe(false);
  });
});
