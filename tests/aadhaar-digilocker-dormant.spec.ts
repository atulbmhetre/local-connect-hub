import { test, expect } from "@playwright/test";
import { getAnonKey, getSupabaseUrl, loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const EDGE = `${getSupabaseUrl()}/functions/v1`;
const ANON = getAnonKey();

async function invoke(name: string) {
  const res = await fetch(`${EDGE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ANON}`,
      apikey: ANON,
    },
    body: JSON.stringify({ p_vendor_phone: "9900012345" }),
  });
  return { status: res.status, body: await res.json() };
}

test("aadhaar-digilocker-initiate is dormant and does not call Decentro", async () => {
  const result = await invoke("aadhaar-digilocker-initiate");
  expect(result.status).toBe(200);
  expect(result.body.dormant).toBe(true);
  expect(result.body.decentro_called).toBe(false);
  expect(result.body.authorizationUrl).toBeUndefined();
});

test("aadhaar-digilocker-complete is dormant and does not call Decentro", async () => {
  const result = await invoke("aadhaar-digilocker-complete");
  expect(result.status).toBe(200);
  expect(result.body.dormant).toBe(true);
  expect(result.body.decentro_called).toBe(false);
});
