import { supabase } from "@/lib/supabase";
import {
  IMAGE_UPLOAD_MAX_EDGE_PX,
  ImageUploadValidationError,
  prepareImageBlob,
} from "@/lib/prepareImageBlob";

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

function mapPrepareError(err: unknown): never {
  if (err instanceof ImageUploadValidationError) {
    switch (err.message) {
      case "unsupported_image_type":
        throw new MenuPhotoValidationError("unsupported_menu_photo_type");
      case "empty_image":
        throw new MenuPhotoValidationError("empty_menu_photo");
      case "image_too_large":
        throw new MenuPhotoValidationError("menu_photo_too_large");
      default:
        throw new MenuPhotoValidationError(err.message);
    }
  }
  throw err;
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

/** Ensure blob is an allowed type, ≤ max edge, and ≤ 5MB. */
export async function prepareMenuPhotoBlob(blob: Blob): Promise<Blob> {
  try {
    return await prepareImageBlob(blob, IMAGE_UPLOAD_MAX_EDGE_PX, MENU_PHOTO_MAX_BYTES);
  } catch (err) {
    mapPrepareError(err);
  }
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
