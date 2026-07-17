import { supabase } from "@/lib/supabase";

export const FEED_IMAGES_BUCKET = "feed-images";

export type FeedImageUploadResult = {
  publicUrl: string;
  path: string;
};

/**
 * Upload an image to the feed-images bucket and return its public URL + storage path.
 */
export async function uploadFeedImage(
  file: File,
  folder: "announcements" | "offers" = "announcements",
): Promise<FeedImageUploadResult> {
  const path = `${folder}/${Date.now()}-${file.name.replace(/\s+/g, "_")}`;
  const { error } = await supabase.storage
    .from(FEED_IMAGES_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (error) throw error;
  const { data } = supabase.storage.from(FEED_IMAGES_BUCKET).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

/** Delete a feed-images object by storage path. Throws on failure. */
export async function deleteFeedImage(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;
  const { error } = await supabase.storage.from(FEED_IMAGES_BUCKET).remove([trimmed]);
  if (error) throw error;
}

/** Best-effort cleanup — logs and never throws. */
export async function bestEffortDeleteFeedImage(
  path: string | null | undefined,
): Promise<void> {
  if (!path?.trim()) return;
  try {
    await deleteFeedImage(path);
  } catch (err) {
    console.error("deleteFeedImage", err);
  }
}

type SubmitResult<T> = { data?: T; error: unknown | null };

/**
 * Optional image upload + submit. If submit returns/throws an error after a
 * successful upload, best-effort deletes the storage object so it is not orphaned.
 */
export async function withOptionalFeedImageUpload<T>(
  file: File | null | undefined,
  folder: "announcements" | "offers",
  submit: (imageUrl: string | null) => Promise<SubmitResult<T>>,
): Promise<SubmitResult<T>> {
  let uploadedPath: string | null = null;
  let imageUrl: string | null = null;

  if (file) {
    const uploaded = await uploadFeedImage(file, folder);
    uploadedPath = uploaded.path;
    imageUrl = uploaded.publicUrl;
  }

  try {
    const result = await submit(imageUrl);
    if (result.error != null && uploadedPath) {
      await bestEffortDeleteFeedImage(uploadedPath);
    }
    return result;
  } catch (err) {
    await bestEffortDeleteFeedImage(uploadedPath);
    throw err;
  }
}
