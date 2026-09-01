import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { strings } from "@/lib/strings";
import { SettingsCollapsible } from "@/components/settings/SettingsSection";

/**
 * Mirrors Settings.tsx Account Standing + My Identity collapsible wiring
 * so toggle behavior can be asserted without mounting the full Settings page.
 */
function AccountStandingCollapsibleHarness() {
  const [identityOpen, setIdentityOpen] = useState(false);
  const [accountStandingOpen, setAccountStandingOpen] = useState(false);
  const s = strings.en;

  return (
    <div>
      <SettingsCollapsible
        label={s.settings_myIdentity}
        open={identityOpen}
        onToggle={() => setIdentityOpen((o) => !o)}
        nested
        testId="settings-identity-toggle"
      >
        <div data-testid="identity-body">phone</div>
      </SettingsCollapsible>

      <SettingsCollapsible
        label={s.settings_accountStanding}
        open={accountStandingOpen}
        onToggle={() => setAccountStandingOpen((o) => !o)}
        nested
        testId="settings-account-standing-toggle"
      >
        <div className="px-4 py-3" data-testid="account-standing-row">
          <span>{s.trust_status_good}</span>
        </div>
      </SettingsCollapsible>
    </div>
  );
}

describe("Account Standing SettingsCollapsible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles open/closed on tap like My Identity", () => {
    render(<AccountStandingCollapsibleHarness />);

    expect(screen.queryByTestId("account-standing-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("identity-body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-account-standing-toggle"));
    expect(screen.getByTestId("account-standing-row")).toBeInTheDocument();
    expect(screen.getByText(strings.en.trust_status_good)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-account-standing-toggle"));
    expect(screen.queryByTestId("account-standing-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-identity-toggle"));
    expect(screen.getByTestId("identity-body")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-identity-toggle"));
    expect(screen.queryByTestId("identity-body")).not.toBeInTheDocument();
  });
});
