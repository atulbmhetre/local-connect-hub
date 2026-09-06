import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MAX_EDGE_PX,
  ImageUploadValidationError,
  assertImageBlob,
  prepareImageBlob,
} from "@/lib/prepareImageBlob";

describe("prepareImageBlob", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 3000,
        close: vi.fn(),
      })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      callback(new Blob([new Uint8Array(128)], { type: "image/jpeg" }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns small blobs unchanged when dimensions fit", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 800,
        height: 600,
        close: vi.fn(),
      })),
    );
    const input = new Blob([new Uint8Array(64)], { type: "image/jpeg" });
    const out = await prepareImageBlob(input, IMAGE_UPLOAD_MAX_EDGE_PX, IMAGE_UPLOAD_MAX_BYTES);
    expect(out).toBe(input);
    expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled();
  });

  it("re-encodes when long edge exceeds maxEdge", async () => {
    const input = new Blob([new Uint8Array(64)], { type: "image/jpeg" });
    const out = await prepareImageBlob(input, IMAGE_UPLOAD_MAX_EDGE_PX, IMAGE_UPLOAD_MAX_BYTES);
    expect(out).not.toBe(input);
    expect(out.type).toBe("image/jpeg");
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalled();
  });

  it("rejects unsupported mime types", async () => {
    await expect(
      prepareImageBlob(new Blob([new Uint8Array(8)], { type: "image/gif" }), 2048, 1024),
    ).rejects.toThrow(ImageUploadValidationError);
  });

  it("assertImageBlob rejects oversize blobs", () => {
    expect(() =>
      assertImageBlob(
        new Blob([new Uint8Array(IMAGE_UPLOAD_MAX_BYTES + 1)], { type: "image/jpeg" }),
        IMAGE_UPLOAD_MAX_BYTES,
      ),
    ).toThrow(ImageUploadValidationError);
  });
});
