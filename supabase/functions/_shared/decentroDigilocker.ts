/**
 * Decentro DigiLocker (classic suite) — live paths from docs.decentro.tech
 * (fetched 2026-09-01). Not invoked while AADHAAR_VERIFICATION_ENABLED is false.
 *
 * Auth (either works; we use JWT as requested):
 *   GET {base}/v2/auth/token
 *   body: { grant_type: "client_credentials", client_id, client_secret,
 *           apis: [{ endpoint: "/v2/kyc/digilocker/initiate_session" },
 *                  { endpoint: "/v2/kyc/digilocker/eaadhaar" }] }
 *   JWT is valid ~15 minutes. Use Authorization: Bearer {access_token}
 *   instead of client_id / client_secret on subsequent calls.
 *
 * module_secret: Decentro's general credential docs place it as a request
 * header named `module_secret` for module APIs. DigiLocker OpenAPI for
 * initiate_session / eaadhaar lists only client_id + client_secret; we still
 * send module_secret alongside the Bearer token.
 *
 * Flow (there is no verify_account / get_document on the current suite):
 *   POST /v2/kyc/digilocker/initiate_session
 *     body: reference_id, consent, consent_purpose (20–50 chars), redirect_url
 *     → data.authorizationUrl, decentroTxnId
 *   User completes DigiLocker on authorizationUrl.
 *   POST /v2/kyc/digilocker/eaadhaar
 *     body: initial_decentro_transaction_id, consent, consent_purpose, reference_id
 *     Do NOT send generate_xml / generate_pdf — we do not persist the document.
 *     data.aadhaarUid is masked ("xxxxxxxx1234"); name/DOB in proofOfIdentity;
 *     address in proofOfAddress. We do not store any of those fields.
 *
 * Staging: https://in.staging.decentro.tech
 * Production: https://in.decentro.tech
 */

export const DECENTRO_CONSENT_PURPOSE = "Vendor identity verification on Aaspaas";

export type DecentroJson = {
  decentroTxnId?: string;
  status?: string;
  responseCode?: string;
  responseKey?: string;
  message?: string;
  data?: {
    authorizationUrl?: string;
    aadhaarUid?: string;
    proofOfIdentity?: Record<string, unknown>;
    proofOfAddress?: Record<string, unknown>;
    xml?: string;
    pdf?: string;
    image?: string;
  };
  access_token?: string;
  response_key?: string;
  response_message?: string;
};

function envTrim(name: string): string {
  return Deno.env.get(name)?.trim() ?? "";
}

export function decentroBaseUrl(): string {
  const fromEnv = envTrim("DECENTRO_BASE_URL");
  return fromEnv || "https://in.staging.decentro.tech";
}

export function readDecentroSecrets(): {
  clientId: string;
  clientSecret: string;
  moduleSecret: string;
} | null {
  const clientId = envTrim("DECENTRO_CLIENT_ID");
  const clientSecret = envTrim("DECENTRO_CLIENT_SECRET");
  const moduleSecret = envTrim("DECENTRO_KYC_MODULE_SECRET");
  if (!clientId || !clientSecret || !moduleSecret) return null;
  return { clientId, clientSecret, moduleSecret };
}

export async function fetchDecentroJwt(
  secrets: { clientId: string; clientSecret: string },
  baseUrl: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/v2/auth/token`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: secrets.clientId,
      client_secret: secrets.clientSecret,
      apis: [
        { endpoint: "/v2/kyc/digilocker/initiate_session" },
        { endpoint: "/v2/kyc/digilocker/eaadhaar" },
      ],
    }),
  });
  const json = (await res.json()) as DecentroJson;
  const token = json.access_token?.trim();
  if (!token) {
    throw new Error(
      json.response_message || json.message || "decentro_jwt_failed",
    );
  }
  return token;
}

export async function decentroPost(
  path: string,
  body: Record<string, unknown>,
  jwt: string,
  moduleSecret: string,
  baseUrl: string,
): Promise<{ http: number; json: DecentroJson }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      module_secret: moduleSecret,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as DecentroJson;
  return { http: res.status, json };
}
