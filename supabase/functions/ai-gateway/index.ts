import "@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type GatewayAction = "classify_category" | "ai_bridge_brief" | "transcribe_parchi";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: CORS_HEADERS });
}

function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

async function callGroq(system: string, user: string) {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("Missing GROQ_API_KEY");

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text =
    typeof data?.choices?.[0]?.message?.content === "string"
      ? data.choices[0].message.content.trim()
      : "";

  return { data, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const action = body?.action as GatewayAction | undefined;

    if (!action) {
      return jsonResponse({ error: "Missing action" }, 400);
    }

    if (action === "classify_category") {
      const input = String(body?.input ?? "").trim();
      if (!input) return jsonResponse({ error: "Missing input" }, 400);

      const system =
        "You are a category classifier for an Indian hyperlocal help app. Return ONLY a JSON object with fields: canonical (proper English category name), mode (help or delivery), emoji (single emoji), hindi (Hindi name). Always use these exact canonical names for common Indian categories: Kirana Store (not Grocery Store or Grocery), Pharmacy (not Medical Store), Electrician (not Electric), Mechanic (not Garage).";
      const { text } = await callGroq(system, input);
      const parsed = extractJson<{
        canonical?: string;
        mode?: "help" | "delivery";
        emoji?: string;
        hindi?: string;
      }>(text);

      if (!parsed?.canonical) {
        return jsonResponse(
          {
            action,
            result: { canonical: "Other", mode: "help", emoji: "✨", hindi: "अन्य" },
            raw: text,
          },
          200,
        );
      }

      return jsonResponse({
        action,
        result: {
          canonical: parsed.canonical,
          mode: parsed.mode === "delivery" ? "delivery" : "help",
          emoji: parsed.emoji ?? "✨",
          hindi: parsed.hindi ?? "अन्य",
        },
      });
    }

    if (action === "ai_bridge_brief") {
      const vendor = body?.vendor;
      const userNeed = String(body?.user_need ?? "").trim();
      if (!vendor || !userNeed) {
        return jsonResponse({ error: "Missing vendor or user_need" }, 400);
      }

      const system =
        "You create short vendor call briefs for a hyperlocal help app. Return ONLY JSON: {\"brief\":\"...\"}. Keep it exactly 2 concise sentences for the vendor: what user needs + what to confirm before dispatch.";
      const { text } = await callGroq(
        system,
        JSON.stringify({ vendor, user_need: userNeed }),
      );
      const parsed = extractJson<{ brief?: string }>(text);

      return jsonResponse({
        action,
        result: {
          brief:
            parsed?.brief ??
            `Customer needs: ${userNeed}. Confirm exact location, urgency, and estimated arrival before dispatch.`,
        },
      });
    }

    if (action === "transcribe_parchi") {
      const input = String(body?.input ?? "").trim();
      if (!input) return jsonResponse({ error: "Missing input" }, 400);

      const system =
        "You clean and structure Indian grocery or service 'parchi' text. Return ONLY JSON with: list_type (grocery|service|mixed), cleaned_text, items (array of strings).";
      const { text } = await callGroq(system, input);
      const parsed = extractJson<{
        list_type?: "grocery" | "service" | "mixed";
        cleaned_text?: string;
        items?: string[];
      }>(text);

      return jsonResponse({
        action,
        result: {
          list_type: parsed?.list_type ?? "mixed",
          cleaned_text: parsed?.cleaned_text ?? input,
          items: Array.isArray(parsed?.items) ? parsed!.items : [],
        },
      });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected server error" },
      500,
    );
  }
});
