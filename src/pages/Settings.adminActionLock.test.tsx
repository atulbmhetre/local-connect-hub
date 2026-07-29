import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";

/**
 * Mirrors Settings.tsx confirmBanUser lock wiring so double-tap behavior
 * can be asserted without mounting the full Settings page.
 */
function ConfirmBanUserHarness({
  onRpc,
  onNotify,
}: {
  onRpc: (phone: string, reason: string) => Promise<{ error: null | { message: string } }>;
  onNotify: (phone: string) => void;
}) {
  const adminUserActionLockRef = useRef(new Set<string>());
  const [flaggedAction, setFlaggedAction] = useState<string | null>(null);
  const [reason, setReason] = useState("spam");

  const confirmBanUser = async (phone: string) => {
    if (!phone || !reason.trim()) return;
    if (adminUserActionLockRef.current.has(phone)) return;
    adminUserActionLockRef.current.add(phone);
    setFlaggedAction(phone);

    try {
      const { error } = await onRpc(phone, reason.trim());
      if (error) return;
      onNotify(phone);
    } finally {
      adminUserActionLockRef.current.delete(phone);
      setFlaggedAction((current) => (current === phone ? null : current));
    }
  };

  return (
    <div>
      <input
        aria-label="ban-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="button"
        data-testid="admin-ban-user-confirm"
        disabled={flaggedAction != null}
        onClick={() => void confirmBanUser("9876543210")}
      >
        Ban user
      </button>
    </div>
  );
}

describe("Settings admin ban submit lock", () => {
  const onRpc = vi.fn();
  const onNotify = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rapid double-tap on ban user calls admin RPC and notify only once", async () => {
    let resolveRpc: (() => void) | undefined;
    const rpcGate = new Promise<void>((resolve) => {
      resolveRpc = resolve;
    });

    onRpc.mockImplementation(async () => {
      await rpcGate;
      return { error: null };
    });

    render(<ConfirmBanUserHarness onRpc={onRpc} onNotify={onNotify} />);

    const btn = screen.getByTestId("admin-ban-user-confirm");
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onRpc).toHaveBeenCalledTimes(1);
    });

    resolveRpc?.();
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledTimes(1);
    });
  });
});
