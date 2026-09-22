import { describe, expect, it, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { loadStringBundle, strings } from "@/lib/strings";
import {
  VendorPauseBlockedSheet,
  VendorPauseConfirmDialog,
} from "@/components/settings/VendorPauseDialogs";
import type { VendorPausePreflight } from "@/lib/vendorPauseUi";
import { fillPauseTemplate } from "@/lib/vendorPauseUi";

beforeAll(async () => {
  await loadStringBundle("hi");
  await loadStringBundle("mr");
});

const PAUSE_I18N_KEYS = [
  "vendor_pause_note",
  "vendor_pause_ledger_note",
  "vendor_pause_billing_freeze",
  "vendor_pause_open_work_title",
  "vendor_pause_open_work_serve",
  "vendor_pause_open_work_help",
  "vendor_pause_open_work_delivery",
  "vendor_pause_open_work_appointment",
  "vendor_pause_blocked_grace",
  "vendor_pause_blocked_expired",
  "vendor_pause_blocked_subscription",
  "vendor_pause_confirm_title",
  "vendor_pause_confirm_action",
  "vendor_pause_since",
  "vendor_pause_resume_credited",
  "vendor_pause_resume_under_min",
  "vendor_pause_resume_too_soon",
  "vendor_pause_preflight_failed",
  "vendor_pause_got_it",
] as const;

const allowedPreflight: VendorPausePreflight = {
  can_pause: true,
  block_reason: null,
  open_work: { help: 0, delivery: 0, appointment: 0 },
  khata: { pending_amount: 250, customer_count: 2 },
  upi_claims_pending: 1,
  subscription_status: "trial",
  will_freeze_billing: true,
  pause_min_credit_days: 7,
};

describe("pause i18n catalogues", () => {
  it("covers EN/HI/MR keys without धंधा", () => {
    const enNote =
      "Pausing hides your business from customers. If you pause for {N} days or more, your subscription is extended by the paused days when you resume. Shorter pauses don't extend it, and money already paid is not refunded.";
    expect(strings.en.vendor_pause_note).toBe(enNote);
    expect(strings.en.vendor_pause_open_work_serve).toBe("Serve or cancel these first.");
    expect(strings.en.vendor_pause_resume_credited).toBe("Subscription extended by {X} days");
    expect(strings.en.vendor_pause_resume_under_min).toBe(
      "Paused {Y} days, under {N}, no extension",
    );

    for (const lang of ["hi", "mr"] as const) {
      for (const key of PAUSE_I18N_KEYS) {
        const value = strings[lang][key];
        expect(value, `${lang}.${key}`).toBeTruthy();
        expect(value, `${lang}.${key}`).not.toBe(strings.en[key]);
        expect(String(value)).not.toMatch(/धंधा/);
      }
    }
  });
});

describe("VendorPauseBlockedSheet", () => {
  it("lists open-work counts with links and serve-or-cancel copy", () => {
    render(
      <MemoryRouter>
        <VendorPauseBlockedSheet
          open
          onOpenChange={() => {}}
          kind="open_work"
          preflight={{
            ...allowedPreflight,
            can_pause: false,
            block_reason: "open_work",
            open_work: { help: 2, delivery: 1, appointment: 0 },
          }}
          s={strings.en}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("vendor-pause-blocked-sheet")).toBeInTheDocument();
    expect(screen.getByText("Serve or cancel these first.")).toBeInTheDocument();
    expect(screen.getByTestId("vendor-pause-open-work-count-help")).toHaveTextContent("2");
    expect(screen.getByTestId("vendor-pause-open-work-count-delivery")).toHaveTextContent("1");
    expect(screen.queryByTestId("vendor-pause-open-work-link-appointment")).not.toBeInTheDocument();
    expect(screen.getByTestId("vendor-pause-open-work-link-help")).toHaveAttribute(
      "href",
      "/vendor#vendor-incoming-orders",
    );
  });

  it("shows grace subscription copy instead of a generic error", () => {
    render(
      <MemoryRouter>
        <VendorPauseBlockedSheet
          open
          onOpenChange={() => {}}
          kind="subscription"
          preflight={{
            ...allowedPreflight,
            can_pause: false,
            block_reason: "subscription_state",
            subscription_status: "grace",
          }}
          s={strings.en}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("vendor-pause-subscription-body")).toHaveTextContent(
      strings.en.vendor_pause_blocked_grace,
    );
    expect(screen.queryByText(strings.en.vendor_pause_save_failed)).not.toBeInTheDocument();
  });
});

describe("VendorPauseConfirmDialog", () => {
  it("shows pause note, ledger line, and billing freeze", () => {
    render(
      <VendorPauseConfirmDialog
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        confirming={false}
        preflight={allowedPreflight}
        s={strings.en}
      />,
    );
    expect(screen.getByTestId("vendor-pause-confirm-note")).toHaveTextContent(
      fillPauseTemplate(strings.en.vendor_pause_note, { N: 7 }),
    );
    expect(screen.getByTestId("vendor-pause-confirm-ledger")).toHaveTextContent(
      "₹250 pending from 2 customers",
    );
    expect(screen.getByTestId("vendor-pause-confirm-billing")).toHaveTextContent(
      strings.en.vendor_pause_billing_freeze,
    );
  });
});
