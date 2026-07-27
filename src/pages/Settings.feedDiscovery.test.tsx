import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { strings } from "@/lib/strings";
import {
  SettingsCollapsible,
  SettingsParentCollapsible,
} from "@/components/settings/SettingsSection";

/**
 * Mirrors Settings.tsx MY ACCOUNT nesting for Local Feed (feed discovery)
 * so collapsible placement can be asserted without mounting full Settings.
 */
function FeedDiscoveryCollapsibleHarness() {
  const [accountOpen, setAccountOpen] = useState(true);
  const [feedDiscoveryOpen, setFeedDiscoveryOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const s = strings.en;

  return (
    <SettingsParentCollapsible
      label={s.settings_myAccount}
      open={accountOpen}
      onToggle={() => setAccountOpen((o) => !o)}
    >
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
        label={s.nav_feed}
        open={feedDiscoveryOpen}
        onToggle={() => setFeedDiscoveryOpen((o) => !o)}
        nested
        testId="settings-feed-discovery-toggle"
      >
        <div data-testid="settings-feed-discovery">
          <p>{s.settings_feedDiscoveryRadius}</p>
          <p>{s.settings_feedNotifications}</p>
        </div>
      </SettingsCollapsible>
    </SettingsParentCollapsible>
  );
}

describe("Local Feed SettingsCollapsible under MY ACCOUNT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts closed and toggles open/closed like siblings", () => {
    render(<FeedDiscoveryCollapsibleHarness />);

    expect(screen.getByTestId("settings-feed-discovery-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-feed-discovery")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-feed-discovery-toggle"));
    expect(screen.getByTestId("settings-feed-discovery")).toBeInTheDocument();
    expect(screen.getByText(strings.en.settings_feedDiscoveryRadius)).toBeInTheDocument();
    expect(screen.getByText(strings.en.settings_feedNotifications)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-feed-discovery-toggle"));
    expect(screen.queryByTestId("settings-feed-discovery")).not.toBeInTheDocument();
  });

  it("lives under MY ACCOUNT parent (hidden when parent collapses)", () => {
    render(<FeedDiscoveryCollapsibleHarness />);

    fireEvent.click(screen.getByTestId("settings-feed-discovery-toggle"));
    expect(screen.getByTestId("settings-feed-discovery")).toBeInTheDocument();

    fireEvent.click(screen.getByText(strings.en.settings_myAccount));
    expect(screen.queryByTestId("settings-feed-discovery-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-feed-discovery")).not.toBeInTheDocument();
  });
});
