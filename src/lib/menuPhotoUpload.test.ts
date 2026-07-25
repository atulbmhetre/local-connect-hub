import { describe, expect, it } from "vitest";
import {
  MENU_PHOTO_MAX_BYTES,
  assertMenuPhotoBlob,
  MenuPhotoValidationError,
} from "@/lib/menuPhotoUpload";

describe("menuPhotoUpload client gate", () => {
  it("accepts small jpeg blobs", () => {
    expect(() =>
      assertMenuPhotoBlob(new Blob([new Uint8Array(64)], { type: "image/jpeg" })),
    ).not.toThrow();
  });

  it("rejects oversize blobs before upload", () => {
    expect(() =>
      assertMenuPhotoBlob(
        new Blob([new Uint8Array(MENU_PHOTO_MAX_BYTES + 1)], { type: "image/jpeg" }),
      ),
    ).toThrow(MenuPhotoValidationError);
  });

  it("rejects unsupported mime types", () => {
    expect(() =>
      assertMenuPhotoBlob(new Blob([new Uint8Array(32)], { type: "image/gif" })),
    ).toThrow(MenuPhotoValidationError);
  });
});
