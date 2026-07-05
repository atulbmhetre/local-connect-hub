import { describe, expect, it } from "vitest";
import { parseBillEditErrorCode } from "@/lib/billEdit";

describe("parseBillEditErrorCode", () => {
  it("parses late_edit_confirmation_required from Postgres exception message", () => {
    expect(
      parseBillEditErrorCode(
        'ERROR: late_edit_confirmation_required (SQLSTATE P0001)',
      ),
    ).toBe("late_edit_confirmation_required");
  });

  it("parses reason_required from Postgres exception message", () => {
    expect(parseBillEditErrorCode("reason_required")).toBe("reason_required");
  });

  it("parses would_create_customer_credit from Postgres exception message", () => {
    expect(
      parseBillEditErrorCode(
        "would_create_customer_credit: bill edit would over-credit customer",
      ),
    ).toBe("would_create_customer_credit");
  });

  it("returns null for unrecognized error codes", () => {
    expect(parseBillEditErrorCode("insufficient_stock")).toBeNull();
    expect(parseBillEditErrorCode("something went wrong")).toBeNull();
  });
});
