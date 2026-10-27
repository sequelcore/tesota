import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

/** Retry diagnostics use the session's existing out-of-conversation custom data entry. */
export const providerRetryType = "tesota.providerRetry";

/** Additional terminal categories the engine requires beyond pi-ai's classifier. */
const terminalType = /quota|credit|balance|budget|billing|spend(?:ing)?[_ -]*(?:limit|cap)|(?:plan|subscription|usage)[_ -]*(?:\w+[_ -]*)?(?:exhaust|exceed|limit)|authenticat|unauthorized|invalid[_ -]*(?:(?:api[_ -]*)?key|request|argument)|not[_ -]*found|permission[_ -]*(?:denied|error)/i;

/** Only retry evidence is retained here; never headers, bodies or credentials. */
export interface RetryEvidence {
  status: number;
  delayMs: number;
  types: string[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function headerWait(headers: unknown): number {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(record(headers));
  let wait = 0;
  for (const [name, value] of entries) {
    if (typeof value !== "string") continue;
    const key = name.toLowerCase();
    if (key !== "retry-after" && key !== "retry-after-ms") continue;
    const numeric = Number(value);
    const ms = Number.isFinite(numeric) ? numeric * (key === "retry-after" ? 1000 : 1)
      : key === "retry-after" ? Date.parse(value) - Date.now() : 0;
    if (Number.isFinite(ms)) wait = Math.max(wait, Math.ceil(ms));
  }
  return wait;
}

/** pi-ai exposes HTTP metadata via onResponse, and some adapters via diagnostics or thrown SDK errors. */
export function observeProviderError(evidence: RetryEvidence, value: unknown, depth = 0): void {
  if (depth > 3 || typeof value !== "object" || value === null) return;
  const data = record(value);
  const status = [data["status"], data["statusCode"], record(data["$metadata"])["httpStatusCode"], data["code"]]
    .find((value) => typeof value === "number" && Number.isInteger(value) && value >= 400 && value < 600);
  if (typeof status === "number") evidence.status = status;
  evidence.delayMs = Math.max(evidence.delayMs, headerWait(data["headers"]));
  for (const key of ["type", "code", "errorCode", "name"]) {
    if (typeof data[key] === "string") evidence.types.push(data[key]);
  }
  for (const key of ["error", "cause", "response", "details"]) observeProviderError(evidence, data[key], depth + 1);
}

/** Observe failed HTTP responses before SDK adapters flatten their headers into error text. */
export function providerFetch(evidence: RetryEvidence): typeof fetch {
  const fetcher = globalThis.fetch;
  const observing = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await fetcher(...args);
    observeProviderError(evidence, response);
    return response;
  };
  return Object.assign(observing, { preconnect: fetcher.preconnect });
}

/** Read back usage from a saved retry diagnostic without adding its failed reply to model history. */
export function providerRetryTokens(data: unknown): { input: number; output: number; total: number } | undefined {
  const usage = record(record(record(data)["message"])["usage"]);
  const input = usage["input"];
  const output = usage["output"];
  const total = usage["totalTokens"];
  if (typeof input !== "number" || typeof output !== "number" || typeof total !== "number"
    || !Number.isFinite(input) || !Number.isFinite(output) || !Number.isFinite(total)) return undefined;
  return { input, output, total };
}

/** Normalize only retry evidence, not the diagnostic displayed to the operator. */
export function providerFailure(message: AssistantMessage, evidence: RetryEvidence): { terminal: boolean; transient: boolean; status: number } {
  for (const diagnostic of message.diagnostics ?? []) observeProviderError(evidence, diagnostic);
  const text = message.errorMessage ?? "";
  // Google's ApiError message carries the HTTP code in its JSON body, not a numeric prefix.
  try {
    const body: unknown = JSON.parse(text.slice(text.indexOf("{")));
    observeProviderError(evidence, body);
  } catch { /* Providers also return plain text; do not infer a status from arbitrary numeric substrings. */ }
  const status = evidence.status || Number((/^\s*(?:HTTP\s+)?([45]\d\d)\b/i.exec(text)
    ?? /^[^\n:]{1,100}\(([45]\d\d)\):/.exec(text))?.[1] ?? 0);
  const types = evidence.types.join(" ");
  // Reuse pi-ai's text classifier for returned errors and transport/type evidence, rather than duplicating it.
  const classified = { ...message, errorMessage: `${text} ${types}` };
  return { terminal: terminalType.test(classified.errorMessage),
    transient: isRetryableAssistantError(classified), status };
}
