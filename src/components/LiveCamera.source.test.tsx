import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CameraSource } from "@capacitor/camera";

const { getPhotoMock, isNativeMock, getUserMediaMock } = vi.hoisted(() => ({
  getPhotoMock: vi.fn(async () => ({ dataUrl: "data:image/jpeg;base64,aa" })),
  isNativeMock: vi.fn(() => true),
  getUserMediaMock: vi.fn(),
}));

vi.mock("@capacitor/camera", async () => {
  const actual = await vi.importActual<typeof import("@capacitor/camera")>("@capacitor/camera");
  return {
    ...actual,
    Camera: { getPhoto: getPhotoMock },
  };
});

vi.mock("@capacitor/app", () => ({
  App: { openUrl: vi.fn() },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativeMock() },
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      camera_capture_failed: "fail",
      camera_access_failed: "access",
      camera_go_to_settings: "settings",
      camera_cancel: "cancel",
      camera_take_photo: "Take photo",
      vendor_selfie_capture: "Take selfie",
    },
  }),
}));

vi.mock("@/lib/nativePermissions", () => ({
  ensureNativePermission: vi.fn(async () => "granted"),
  isPermissionGranted: (status: string) => status === "granted" || status === "limited",
}));

vi.mock("@/lib/prepareImageBlob", () => ({
  prepareImageBlob: vi.fn(async (blob: Blob) => blob),
  blobToDataUrl: vi.fn(async () => "data:image/jpeg;base64,aa"),
  IMAGE_UPLOAD_MAX_EDGE_PX: 2048,
  IMAGE_UPLOAD_MAX_BYTES: 5_242_880,
}));

import { prepareImageBlob } from "@/lib/prepareImageBlob";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";

describe("LiveCamera source", () => {
  beforeEach(() => {
    getPhotoMock.mockClear();
    isNativeMock.mockReturnValue(true);
    getUserMediaMock.mockReset();
    delete (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__;
    vi.mocked(prepareImageBlob).mockImplementation(async (blob: Blob) => blob);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
  });

  afterEach(() => {
    delete (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__;
    delete (window as unknown as { __E2E_CAPTURE_HOLD__?: () => Promise<void> }).__E2E_CAPTURE_HOLD__;
    vi.unstubAllGlobals();
  });

  it("keeps verification captures camera-only by default", async () => {
    render(
      <LiveCamera
        open
        onClose={() => undefined}
        onCapture={() => undefined}
        requireLocation={false}
      />,
    );
    await vi.waitFor(() => expect(getPhotoMock).toHaveBeenCalled());
    expect(getPhotoMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: CameraSource.Camera }),
    );
  });

  it("uses live getUserMedia on web instead of the native camera plugin", async () => {
    isNativeMock.mockReturnValue(false);
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] };
    getUserMediaMock.mockResolvedValue(stream);

    render(
      <LiveCamera
        open
        onClose={() => undefined}
        onCapture={() => undefined}
        facing="front"
        requireLocation={false}
      />,
    );

    await vi.waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    expect(getPhotoMock).not.toHaveBeenCalled();
    expect(getUserMediaMock).toHaveBeenCalledWith({
      video: { facingMode: "user" },
      audio: false,
    });
    expect(screen.getByTestId("live-camera-web")).toBeInTheDocument();
    expect(screen.getByTestId("live-camera-web-shutter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /gallery|upload|choose file/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  });

  it("still delivers the mock capture after an unrelated parent re-render mid-flight", async () => {
    isNativeMock.mockReturnValue(false);
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;

    let releasePrep!: () => void;
    const prepGate = new Promise<void>((resolve) => {
      releasePrep = resolve;
    });
    let holdEntered = false;
    (window as unknown as { __E2E_CAPTURE_HOLD__?: () => Promise<void> }).__E2E_CAPTURE_HOLD__ =
      async () => {
        holdEntered = true;
        await prepGate;
      };

    function Parent() {
      const [tick, setTick] = useState(0);
      const [shot, setShot] = useState<CapturedShot | null>(null);
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            bump-{tick}
          </button>
          <LiveCamera
            open={open}
            onClose={() => setOpen(false)}
            onCapture={(next) => setShot(next)}
            requireLocation={false}
          />
          {shot ? <span data-testid="captured-blob-size">{String(shot.blob.size)}</span> : null}
        </div>
      );
    }

    render(<Parent />);
    await vi.waitFor(() => expect(holdEntered).toBe(true));
    fireEvent.click(screen.getByText("bump-0"));
    expect(screen.getByText("bump-1")).toBeInTheDocument();
    releasePrep();
    await vi.waitFor(() => {
      expect(screen.getByTestId("captured-blob-size")).toBeInTheDocument();
    });
  });

  it("aborts an in-flight capture when the user closes the camera before it finishes", async () => {
    isNativeMock.mockReturnValue(false);
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;

    let releasePrep!: () => void;
    const prepGate = new Promise<void>((resolve) => {
      releasePrep = resolve;
    });
    let holdEntered = false;
    (window as unknown as { __E2E_CAPTURE_HOLD__?: () => Promise<void> }).__E2E_CAPTURE_HOLD__ =
      async () => {
        holdEntered = true;
        await prepGate;
      };

    const onCapture = vi.fn();
    function Parent() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setOpen(false)}>
            user-cancel
          </button>
          <LiveCamera
            open={open}
            onClose={() => setOpen(false)}
            onCapture={onCapture}
            requireLocation={false}
          />
        </div>
      );
    }

    render(<Parent />);
    await vi.waitFor(() => expect(holdEntered).toBe(true));
    expect(onCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("user-cancel"));
    releasePrep();
    await prepGate;
    await Promise.resolve();
    expect(onCapture).not.toHaveBeenCalled();
  });
});
