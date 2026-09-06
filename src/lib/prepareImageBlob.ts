/** Shared client-side image prep: type gate, long-edge downscale, JPEG re-encode to ≤ maxBytes. */
export const IMAGE_UPLOAD_MAX_BYTES = 5_242_880;
export const IMAGE_UPLOAD_MAX_EDGE_PX = 2048;

export const IMAGE_UPLOAD_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export class ImageUploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadValidationError";
  }
}

function normalizeType(type: string | undefined): string {
  return (type || "image/jpeg").toLowerCase();
}

export function assertImageBlob(blob: Blob, maxBytes: number): void {
  const type = normalizeType(blob.type);
  if (!IMAGE_UPLOAD_ALLOWED_TYPES.has(type)) {
    throw new ImageUploadValidationError("unsupported_image_type");
  }
  if (blob.size <= 0) {
    throw new ImageUploadValidationError("empty_image");
  }
  if (blob.size > maxBytes) {
    throw new ImageUploadValidationError("image_too_large");
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read_blob_failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale to maxEdge (long edge) and re-encode as JPEG until ≤ maxBytes.
 * Returns the input unchanged when already within both limits.
 */
export async function prepareImageBlob(
  blob: Blob,
  maxEdge: number,
  maxBytes: number,
): Promise<Blob> {
  const type = normalizeType(blob.type);
  if (!IMAGE_UPLOAD_ALLOWED_TYPES.has(type)) {
    throw new ImageUploadValidationError("unsupported_image_type");
  }
  if (blob.size <= 0) {
    throw new ImageUploadValidationError("empty_image");
  }

  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    if (blob.size <= maxBytes) return blob;
    throw new ImageUploadValidationError("image_too_large");
  }

  const bitmap = await createImageBitmap(blob);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    const longEdge = Math.max(width, height);
    if (longEdge > maxEdge) {
      const scale = maxEdge / longEdge;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }

    if (width === bitmap.width && height === bitmap.height && blob.size <= maxBytes) {
      return blob;
    }

    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const compressed = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
      );
      if (compressed && compressed.size > 0 && compressed.size <= maxBytes) {
        return compressed;
      }
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
      quality = Math.max(0.5, quality - 0.1);
    }
  } finally {
    bitmap.close();
  }

  throw new ImageUploadValidationError("image_too_large");
}
