import { describe, expect, it, vi, beforeEach } from "vitest";
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

import { LiveCamera } from "@/components/LiveCamera";

describe("LiveCamera source", () => {
  beforeEach(() => {
    getPhotoMock.mockClear();
    isNativeMock.mockReturnValue(true);
    getUserMediaMock.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
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
});
