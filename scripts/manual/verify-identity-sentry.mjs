/**
 * Sends three tagged test exceptions through the same Sentry DSN used by
 * src/lib/sentry.ts, one for each identity failure scope. Prints store
 * event IDs so TEST verification can confirm ingest accepted them.
 *
 * WARNING: This posts real events to the production Sentry project and
 * consumes Developer-tier quota. Run manually only when verifying wiring —
 * never wire into CI, npm scripts, or scheduled jobs.
 *
 * Usage: node scripts/manual/verify-identity-sentry.mjs
 */
const DSN =
  "https://a2f4812f5a59fecb0b02531fddfded05@o4511633087332352.ingest.us.sentry.io/4511633127178240";

const match = DSN.match(
  /^https:\/\/([a-f0-9]+)@([^.]+)\.ingest\.([a-z.]+)\/(\d+)/,
);
if (!match) {
  console.error("Could not parse Sentry DSN");
  process.exit(1);
}
const [, publicKey, org, host, projectId] = match;
const storeUrl = `https://${org}.ingest.${host}/api/${projectId}/store/?sentry_key=${publicKey}&sentry_version=7`;

const stamp = `identity-obs-${Date.now()}`;
const scopes = [
  "firstOpen.restore",
  "phoneEntry.checkExistingAccount",
  "userIdentity.ensureUserDeviceLink",
];

async function send(scope) {
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const body = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: "error",
    environment: "test",
    message: `${stamp}:${scope}`,
    exception: {
      values: [
        {
          type: "Error",
          value: `${stamp}:${scope}`,
          mechanism: { type: "generic", handled: true },
        },
      ],
    },
    tags: {
      scope,
      verification: "identity-observability",
      stamp,
    },
    extra: { scope, verification: true, stamp, sourceFile: scope.split(".")[0] },
  };

  const res = await fetch(storeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sentry store failed for ${scope}: ${res.status} ${text}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { id: eventId, raw: text };
  }
  return { scope, eventId: parsed.id ?? eventId, status: res.status };
}

const results = [];
for (const scope of scopes) {
  results.push(await send(scope));
}
console.log(JSON.stringify({ stamp, results }, null, 2));
