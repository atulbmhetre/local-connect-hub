/**
 * Decentro VerifyPay v3 (UPI VPA penny-drop) — live paths from
 * docs.decentro.tech/reference/verifypay-V3 (fetched 2026-09-16).
 *
 * Not invoked while UPI_VERIFICATION_ENABLED is false.
 *
 * Why VerifyPay, not Validate Bank Account v3:
 *   POST /v3/banking/money_transfer/validate_bank_account (BAV v3) takes
 *   beneficiary_details.account_number + ifsc. It has no upi_vpa field.
 *   POST /v3/banking/verify_pay is the Decfin API that validates a UPI VPA
 *   and returns name_as_per_bank. This function uses that API.
 *
 * Consumer URNs (Dashboard secrets only — never commit values):
 *   DECENTRO_DECFIN_CONSUMER_URN — Master Consumer URN issued with the
 *   aaspaaspro_staging / Decfin Client ID. Body field `consumer_urn` for
 *   VerifyPay. This is the URN this function reads.
 *   A separately issued "Consumer URN for BAV v3" is for BAV v3 only
 *   (account+IFSC). It does not replace the Master URN and is not sent
 *   on VerifyPay. Do not mix URNs across APIs/accounts.
 *
 * Auth: Decfin VerifyPay OpenAPI requires headers client_id + client_secret
 * (not the KYC DECENTRO_CLIENT_ID / DECENTRO_CLIENT_SECRET pair).
 *
 * Staging: https://staging.api.decentro.tech
 * Production: https://api.decentro.tech
 */

export type VerifyPayJson = {
  decentro_txn_id?: string;
  decentroTxnId?: string;
  api_status?: string;
  status?: string;
  response_key?: string;
  responseKey?: string;
  message?: string;
  data?: {
    upi_vpa?: string;
    name_as_per_bank?: string;
    payout_status?: string;
  };
};

function envTrim(name: string): string {
  return Deno.env.get(name)?.trim() ?? "";
}

export function decentroDecfinBaseUrl(): string {
  const fromEnv = envTrim("DECENTRO_DECFIN_BASE_URL");
  return fromEnv || "https://staging.api.decentro.tech";
}

export function readDecfinSecrets(): {
  clientId: string;
  clientSecret: string;
  consumerUrn: string;
} | null {
  const clientId = envTrim("DECENTRO_DECFIN_CLIENT_ID");
  const clientSecret = envTrim("DECENTRO_DECFIN_CLIENT_SECRET");
  const consumerUrn = envTrim("DECENTRO_DECFIN_CONSUMER_URN");
  if (!clientId || !clientSecret || !consumerUrn) return null;
  return { clientId, clientSecret, consumerUrn };
}

export function namesMatchForUpi(claimed: string, bankName: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
      .trim();
  const a = norm(claimed);
  const b = norm(bankName);
  if (!a || !b) return false;
  if (a === b) return true;
  const tokensA = a.split(/\s+/).filter((t) => t.length >= 2);
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length >= 2));
  if (tokensA.length === 0 || tokensB.size === 0) return false;
  const hits = tokensA.filter((t) => tokensB.has(t)).length;
  return hits / Math.max(tokensA.length, tokensB.size) >= 0.5;
}

export async function decentroVerifyPay(
  body: Record<string, unknown>,
  secrets: { clientId: string; clientSecret: string },
  baseUrl: string,
): Promise<{ http: number; json: VerifyPayJson }> {
  const res = await fetch(`${baseUrl}/v3/banking/verify_pay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      client_id: secrets.clientId,
      client_secret: secrets.clientSecret,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as VerifyPayJson;
  return { http: res.status, json };
}
