import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type InitiateCallBody = {
  caller_phone?: string;
  vendor_phone?: string;
  service_mode?: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-+]/g, "").trim();
}

function timeLimitSeconds(serviceMode: string | undefined): number {
  switch ((serviceMode ?? "").toLowerCase()) {
    case "help":
      return 300;
    case "delivery":
      return 120;
    case "appointment":
      return 180;
    default:
      return 180;
  }
}

function extractCallSid(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (typeof obj.call_sid === "string" && obj.call_sid) return obj.call_sid;

  const call = obj.Call;
  if (call && typeof call === "object") {
    const callObj = call as Record<string, unknown>;
    if (typeof callObj.Sid === "string" && callObj.Sid) return callObj.Sid;
    if (typeof callObj.sid === "string" && callObj.sid) return callObj.sid;
  }

  return null;
}

function extractCallSidFromXml(xml: string): string | null {
  const match = xml.match(/<Sid>([^<]+)<\/Sid>/i);
  return match?.[1]?.trim() ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Method not allowed" },
      405,
    );
  }

  try {
    const exotelSid = Deno.env.get("EXOTEL_SID");
    const exotelApiKey = Deno.env.get("EXOTEL_API_KEY");
    const exotelApiToken = Deno.env.get("EXOTEL_API_TOKEN");
    const exotelCallerId = Deno.env.get("EXOTEL_CALLER_ID");

    if (!exotelSid || !exotelApiKey || !exotelApiToken || !exotelCallerId) {
      return jsonResponse(
        {
          success: false,
          error:
            "Missing Exotel configuration (EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_CALLER_ID)",
        },
        500,
      );
    }

    let body: InitiateCallBody;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const callerPhone = body.caller_phone
      ? normalizePhone(body.caller_phone)
      : "";
    const vendorPhone = body.vendor_phone
      ? normalizePhone(body.vendor_phone)
      : "";

    if (!callerPhone || !vendorPhone) {
      return jsonResponse(
        {
          success: false,
          error: "caller_phone and vendor_phone are required",
        },
        400,
      );
    }

    const timeLimit = timeLimitSeconds(body.service_mode);
    const auth = btoa(`${exotelApiKey}:${exotelApiToken}`);

    const form = new URLSearchParams({
      From: callerPhone,
      To: vendorPhone,
      CallerId: exotelCallerId,
      TimeLimit: String(timeLimit),
      Record: "false",
    });

    const exotelRes = await fetch(
      `https://api.exotel.com/v1/Accounts/${exotelSid}/Calls/connect`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );

    const responseText = await exotelRes.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = null;
    }

    if (!exotelRes.ok) {
      const errMsg =
        (parsed &&
          typeof parsed === "object" &&
          "RestException" in parsed &&
          typeof (parsed as { RestException?: { Message?: string } })
            .RestException?.Message === "string" &&
          (parsed as { RestException: { Message: string } }).RestException
            .Message) ||
        responseText ||
        `Exotel API error (${exotelRes.status})`;

      return jsonResponse({ success: false, error: errMsg }, 502);
    }

    const callSid =
      extractCallSid(parsed) ?? extractCallSidFromXml(responseText);

    if (!callSid) {
      return jsonResponse(
        {
          success: false,
          error: "Call initiated but call_sid missing in Exotel response",
        },
        502,
      );
    }

    return jsonResponse({ success: true, call_sid: callSid });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ success: false, error: message }, 500);
  }
});
