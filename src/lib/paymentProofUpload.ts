import { supabase } from "@/lib/supabase";
import {
  IMAGE_UPLOAD_MAX_EDGE_PX,
  ImageUploadValidationError,
  prepareImageBlob,
} from "@/lib/prepareImageBlob";

export const PAYMENT_PROOFS_BUCKET = "payment-proofs";
export const PAYMENT_PROOF_MAX_BYTES = 5_242_880;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export type PaymentProofUploadResult = {
  publicUrl: string;
  path: string;
};

export class PaymentProofValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProofValidationError";
  }
}

function normalizeType(type: string | undefined): string {
  return (type || "image/jpeg").toLowerCase();
}

function mapPrepareError(err: unknown): never {
  if (err instanceof ImageUploadValidationError) {
    switch (err.message) {
      case "unsupported_image_type":
        throw new PaymentProofValidationError("unsupported_payment_proof_type");
      case "empty_image":
        throw new PaymentProofValidationError("empty_payment_proof");
      case "image_too_large":
        throw new PaymentProofValidationError("payment_proof_too_large");
      default:
        throw new PaymentProofValidationError(err.message);
    }
  }
  throw err;
}

export function assertPaymentProofBlob(blob: Blob): void {
  const type = normalizeType(blob.type);
  if (!ALLOWED_TYPES.has(type)) {
    throw new PaymentProofValidationError("unsupported_payment_proof_type");
  }
  if (blob.size <= 0) {
    throw new PaymentProofValidationError("empty_payment_proof");
  }
  if (blob.size > PAYMENT_PROOF_MAX_BYTES) {
    throw new PaymentProofValidationError("payment_proof_too_large");
  }
}

export async function uploadPaymentProof(
  requestId: string,
  blob: Blob,
): Promise<PaymentProofUploadResult> {
  let prepared: Blob;
  try {
    prepared = await prepareImageBlob(blob, IMAGE_UPLOAD_MAX_EDGE_PX, PAYMENT_PROOF_MAX_BYTES);
  } catch (err) {
    mapPrepareError(err);
  }
  assertPaymentProofBlob(prepared);
  const path = `${requestId}/${Date.now()}.jpg`;
  const { error } = await supabase.storage.from(PAYMENT_PROOFS_BUCKET).upload(path, prepared, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(PAYMENT_PROOFS_BUCKET).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}
