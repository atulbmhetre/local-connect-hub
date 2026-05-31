import { supabase } from "@/lib/supabase";

export const FEED_IMAGES_BUCKET = "feed-images";

/**
 * Upload an image to the feed-images bucket and return its public URL.
 */
export async function uploadFeedImage(
  file: File,
  folder: "announcements" | "offers" = "announcements",
): Promise<string> {
  const path = `${folder}/${Date.now()}-${file.name.replace(/\s+/g, "_")}`;
  const { error } = await supabase.storage
    .from(FEED_IMAGES_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (error) throw error;
  const { data } = supabase.storage.from(FEED_IMAGES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
