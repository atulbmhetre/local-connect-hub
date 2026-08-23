/**
 * Sends a tagged verification event with order-accept notify breadcrumbs through
 * the same Sentry DSN used by src/lib/sentry.ts.
 *
 * WARNING: This posts real events to the production Sentry project and
 * consumes Developer-tier quota. Run manually only when verifying wiring —
 * never wire into CI, npm scripts, or scheduled jobs.
 *
 * Usage: node scripts/manual/verify-order-accept-sentry.mjs
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

const stamp = `order-accept-obs-${Date.now()}`;
const requestId = `req-${stamp}`;
const deviceId = `verify-device-${stamp}`;

const breadcrumbs = [
  {
    timestamp: Date.now() / 1000,
    category: "app",
    message: "order_accept.start",
    data: { request_id: requestId, acceptKind: "help" },
    level: "info",
  },
  {
    timestamp: Date.now() / 1000,
    category: "app",
    message: "invokeNotifyUser.invoke",
    data: {
      source: "order_accept",
      type: "order_accepted",
      request_id: requestId,
    },
    level: "info",
  },
  {
    timestamp: Date.now() / 1000,
    category: "app",
    message: "invokeNotifyUser.complete",
    data: {
      source: "order_accept",
      type: "order_accepted",
      request_id: requestId,
    },
    level: "info",
  },
];

async function send() {
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const body = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: "info",
    environment: "test",
    message: `${stamp}:order_accept_notify_observability`,
    user: { id: deviceId },
    breadcrumbs: { values: breadcrumbs },
    tags: {
      verification: "order-accept-notify",
      stamp,
      request_id: requestId,
    },
    extra: {
      verification: true,
      stamp,
      source: "order_accept",
      request_id: requestId,
      phoneSuffix: "4321",
    },
  };

  const res = await fetch(storeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sentry store failed: ${res.status} ${text}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { id: eventId, raw: text };
  }
  return { eventId: parsed.id ?? eventId, status: res.status, stamp, requestId, deviceId };
}

const result = await send();
console.log(JSON.stringify(result, null, 2));
