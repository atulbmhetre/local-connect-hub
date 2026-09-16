import { test, expect } from "@playwright/test";
import { getAnonKey, getSupabaseUrl, loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const EDGE = `${getSupabaseUrl()}/functions/v1`;
const ANON = getAnonKey();

test("upi-vpa-verify is dormant and does not call Decentro", async () => {
  const res = await fetch(`${EDGE}/upi-vpa-verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ANON}`,
      apikey: ANON,
    },
    body: JSON.stringify({ p_vendor_phone: "9900012345" }),
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.dormant).toBe(true);
  expect(body.decentro_called).toBe(false);
  expect(body.status).toBeUndefined();
});
