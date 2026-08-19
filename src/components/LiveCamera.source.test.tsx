import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { CameraSource } from "@capacitor/camera";

const { getPhotoMock } = vi.hoisted(() => ({
  getPhotoMock: vi.fn(async () => ({ dataUrl: "data:image/jpeg;base64,aa" })),
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

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      camera_capture_failed: "fail",
      camera_access_failed: "access",
      camera_go_to_settings: "settings",
      camera_cancel: "cancel",
    },
  }),
}));

import { LiveCamera } from "@/components/LiveCamera";

describe("LiveCamera source", () => {
  it("keeps verification captures camera-only by default", async () => {
    getPhotoMock.mockClear();
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
});
