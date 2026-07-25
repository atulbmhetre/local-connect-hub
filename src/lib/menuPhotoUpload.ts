import { supabase } from "@/lib/supabase";

export const MENU_PHOTOS_BUCKET = "menu-photos";
/** Match storage.buckets.file_size_limit for menu-photos. */
export const MENU_PHOTO_MAX_BYTES = 5_242_880;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export type MenuPhotoUploadResult = {
  publicUrl: string;
  path: string;
};

export class MenuPhotoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MenuPhotoValidationError";
  }
}

function normalizeType(type: string | undefined): string {
  return (type || "image/jpeg").toLowerCase();
}

/** Client-side type + size gate before storage upload (storage still enforces). */
export function assertMenuPhotoBlob(blob: Blob): void {
  const type = normalizeType(blob.type);
  if (!ALLOWED_TYPES.has(type)) {
    throw new MenuPhotoValidationError("unsupported_menu_photo_type");
  }
  if (blob.size <= 0) {
    throw new MenuPhotoValidationError("empty_menu_photo");
  }
  if (blob.size > MENU_PHOTO_MAX_BYTES) {
    throw new MenuPhotoValidationError("menu_photo_too_large");
  }
}

/**
 * Ensure blob is an allowed type and ≤ 5MB. Re-encodes via canvas when oversized.
 */
export async function prepareMenuPhotoBlob(blob: Blob): Promise<Blob> {
  const type = normalizeType(blob.type);
  if (!ALLOWED_TYPES.has(type)) {
    throw new MenuPhotoValidationError("unsupported_menu_photo_type");
  }
  if (blob.size <= 0) {
    throw new MenuPhotoValidationError("empty_menu_photo");
  }
  if (blob.size <= MENU_PHOTO_MAX_BYTES) {
    return blob;
  }

  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new MenuPhotoValidationError("menu_photo_too_large");
  }

  const bitmap = await createImageBitmap(blob);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const compressed = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
      );
      if (compressed && compressed.size > 0 && compressed.size <= MENU_PHOTO_MAX_BYTES) {
        return compressed;
      }
      width *= 0.75;
      height *= 0.75;
      quality = Math.max(0.5, quality - 0.1);
    }
  } finally {
    bitmap.close();
  }

  throw new MenuPhotoValidationError("menu_photo_too_large");
}

export async function uploadMenuPhoto(
  vendorId: string,
  blob: Blob,
): Promise<MenuPhotoUploadResult> {
  const prepared = await prepareMenuPhotoBlob(blob);
  assertMenuPhotoBlob(prepared);
  const path = `${vendorId}/${Date.now()}.jpg`;
  const { error } = await supabase.storage.from(MENU_PHOTOS_BUCKET).upload(path, prepared, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(MENU_PHOTOS_BUCKET).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

export async function bestEffortDeleteMenuPhotoByUrl(
  publicUrl: string | null | undefined,
): Promise<void> {
  const url = publicUrl?.trim();
  if (!url) return;
  try {
    const marker = `/${MENU_PHOTOS_BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx < 0) return;
    const path = decodeURIComponent(url.slice(idx + marker.length).split("?")[0] ?? "");
    if (!path) return;
    await supabase.storage.from(MENU_PHOTOS_BUCKET).remove([path]);
  } catch (err) {
    console.error("bestEffortDeleteMenuPhotoByUrl", err);
  }
}
