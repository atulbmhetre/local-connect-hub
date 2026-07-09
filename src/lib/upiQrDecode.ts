import jsQR from "jsqr";

const UPI_VPA_REGEX = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;

export function parseUpiPayeeIdFromQrPayload(data: string): string | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("upi://pay")) return null;
  try {
    const queryStart = trimmed.indexOf("?");
    const search = queryStart >= 0 ? trimmed.slice(queryStart + 1) : trimmed;
    const pa = new URLSearchParams(search).get("pa")?.trim();
    if (!pa || !UPI_VPA_REGEX.test(pa)) return null;
    return pa;
  } catch {
    return null;
  }
}

export async function decodeUpiPayeeIdFromImageFile(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (!result?.data) return null;
    return parseUpiPayeeIdFromQrPayload(result.data);
  } catch {
    return null;
  }
}
