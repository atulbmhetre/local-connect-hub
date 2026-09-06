import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import { withTimedRetry } from "@/lib/withNetworkRetry";
import {
  dismissNetworkRetryingToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import { getCachedStringBundle, type Language } from "@/lib/strings";

type ParseImageEndpoint = "parse-image-order" | "parse-image-bill";

function readLang(): Language {
  try {
    const stored = localStorage.getItem("aaspaas:language");
    return stored === "hi" || stored === "mr" ? stored : "en";
  } catch {
    return "en";
  }
}

/** Edge parse-image calls with the same timed-retry discipline as place/claim. */
export async function fetchParseImageJson(
  endpoint: ParseImageEndpoint,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const s = getCachedStringBundle(readLang());
  try {
    const data = await withTimedRetry(
      async (signal) => {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) {
          throw new Error(`parse_image_http_${resp.status}`);
        }
        return (await resp.json()) as Record<string, unknown>;
      },
      {
        onRetrying: () => {
          showNetworkRetryingToast({ retrying: s.network_retrying });
        },
        shouldRetry: () => getNavigatorOnline(),
      },
    );
    dismissNetworkRetryingToast();
    return data;
  } catch (err) {
    dismissNetworkRetryingToast();
    throw err;
  }
}
