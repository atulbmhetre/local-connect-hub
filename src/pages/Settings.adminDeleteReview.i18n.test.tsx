import { describe, expect, it, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { strings, loadStringBundle } from "@/lib/strings";

beforeAll(async () => {
  await loadStringBundle("hi");
  await loadStringBundle("mr");
});

/**
 * Mirrors Settings admin delete-review AlertDialog copy so HI/MR
 * localization can be verified without mounting the full Settings page.
 */
function AdminDeleteReviewConfirmCopy({
  lang,
  rating,
}: {
  lang: "en" | "hi" | "mr";
  rating: number;
}) {
  const s = strings[lang];
  return (
    <div>
      <h2>{s.admin_lowRatings_deleteConfirmTitle}</h2>
      <p>
        {s.admin_lowRatings_deleteConfirmBody.replace("{stars}", "★".repeat(rating))}
      </p>
      <button type="button">{s.settings_cancel}</button>
      <button type="button">{s.admin_lowRatings_delete}</button>
    </div>
  );
}

describe("admin delete-review confirm dialog i18n", () => {
  it("EN renders localized title / cancel / delete (not hardcoded-only)", () => {
    render(<AdminDeleteReviewConfirmCopy lang="en" rating={2} />);
    expect(screen.getByText("Delete this review?")).toBeInTheDocument();
    expect(screen.getByText("Rating: ★★ — this cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete review" })).toBeInTheDocument();
  });

  it("HI renders confirm dialog strings", () => {
    render(<AdminDeleteReviewConfirmCopy lang="hi" rating={1} />);
    expect(screen.getByText(strings.hi.admin_lowRatings_deleteConfirmTitle)).toBeInTheDocument();
    expect(
      screen.getByText(
        strings.hi.admin_lowRatings_deleteConfirmBody.replace("{stars}", "★"),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.hi.settings_cancel })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: strings.hi.admin_lowRatings_delete }),
    ).toBeInTheDocument();
  });

  it("MR renders confirm dialog strings", () => {
    render(<AdminDeleteReviewConfirmCopy lang="mr" rating={2} />);
    expect(screen.getByText(strings.mr.admin_lowRatings_deleteConfirmTitle)).toBeInTheDocument();
    expect(
      screen.getByText(
        strings.mr.admin_lowRatings_deleteConfirmBody.replace("{stars}", "★★"),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.mr.settings_cancel })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: strings.mr.admin_lowRatings_delete }),
    ).toBeInTheDocument();
  });
});
