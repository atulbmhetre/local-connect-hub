import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { loadStringBundle, strings } from "@/lib/strings";

beforeAll(async () => {
  await loadStringBundle("hi");
  await loadStringBundle("mr");
});

describe("paused-vendor monthly reminder wiring", () => {
  it("migration schedules remind_paused_vendors and stamps pause_reminder_sent_at", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260921210001_vendor_pause_monthly_reminder.sql"),
      "utf8",
    );
    expect(mig).toContain("pause_reminder_sent_at");
    expect(mig).toContain("remind_paused_vendors");
    expect(mig).toContain("remind-paused-vendors");
    expect(mig).toContain("vendor_paused_reminder");
    expect(mig).toContain("_vendor_inbox_and_fcm");
    expect(mig).toContain("pause_reminder_interval_days");
    const fix = readFileSync(
      resolve("supabase/migrations/20260921220001_paused_vendor_reminder_related_id_null.sql"),
      "utf8",
    );
    expect(fix).toContain("remind_paused_vendors");
    expect(fix).toMatch(/NULL,\s*NULL,\s*NULL,\s*false/);
  });

  it("EN/HI/MR catalogue copy matches the notify body and never uses धंधा", () => {
    expect(strings.en.vendor_pause_reminder_body).toBe(
      "Your business is paused — customers can't see you. Resume anytime.",
    );
    for (const lang of ["hi", "mr"] as const) {
      expect(strings[lang].vendor_pause_reminder_title).toBeTruthy();
      expect(strings[lang].vendor_pause_reminder_body).toBeTruthy();
      expect(strings[lang].vendor_pause_reminder_body).not.toBe(
        strings.en.vendor_pause_reminder_body,
      );
      expect(strings[lang].vendor_pause_reminder_body).toContain("व्यवसाय");
      expect(strings[lang].vendor_pause_reminder_body).not.toMatch(/धंधा/);
    }
  });
});
