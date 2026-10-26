import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Models } from "@earendil-works/pi-ai";
import { claudeCodeExecutable, instanceEnvironment } from "./providers/claude-code.ts";
import { READ_LIMIT_MS, type UsageResponse, type UsageSources } from "./usage.ts";

/** The SDK's query, as the usage report uses it; a test gives a recorded one. */
export interface UsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<unknown>;
  close(): void;
}
export type StartUsageQuery = (input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => UsageQuery;

/**
 * Claude Code's own report of an account's plan limits, read without sending
 * a request: the SDK's experimental usage call on a conversation that is
 * never given a message. Only `CLAUDE_CONFIG_DIR` points Claude Code at the
 * account's folder (`instanceEnvironment`); Tesota never reads or stores
 * what Claude Code signs in with. When `signal` aborts, or the time limit
 * passes, Claude Code is closed and the read fails.
 */
export async function claudeCodeReport(folder: string | undefined, start?: StartUsageQuery, limitMs: number = READ_LIMIT_MS,
  signal?: AbortSignal): Promise<unknown> {
  const program = claudeCodeExecutable();
  if (program === undefined && start === undefined) throw new Error("Claude Code is not installed");
  const begin = start ?? (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as StartUsageQuery;
  if (signal?.aborted === true) throw new Error("the read was stopped");
  const idle = new AbortController();
  // A conversation that ends, with no message, only when the report is in.
  const nothing: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
      idle.signal.addEventListener("abort", () => { resolve({ done: true, value: undefined }); }, { once: true });
    }),
  }) };
  const session = begin({ prompt: nothing, options: { settingSources: [], env: { ...instanceEnvironment(folder), CLAUDE_AGENT_SDK_CLIENT_APP: "tesota" },
    ...program === undefined ? {} : { pathToClaudeCodeExecutable: program } } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  try {
    return await Promise.race([session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error("Claude Code did not report its usage in time")); }, limitMs);
        onAbort = () => { reject(new Error("the read was stopped")); };
        signal?.addEventListener("abort", onAbort, { once: true });
      })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    idle.abort();
    session.close();
  }
}

const codexUrl = "https://chatgpt.com/backend-api/wham/usage";

/** The ChatGPT account a Codex token belongs to, from its own claims, as Codex and pi-ai read it. */
function chatgptAccount(token: string): string | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const auth: unknown = typeof claims === "object" && claims !== null ? Reflect.get(claims, "https://api.openai.com/auth") : undefined;
    const id: unknown = typeof auth === "object" && auth !== null ? Reflect.get(auth, "chatgpt_account_id") : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

/**
 * Codex's usage endpoint for the ChatGPT account `id`, with the account's own
 * credential from Tesota's store, read through pi-ai so a sign-in that expired
 * is refreshed. The token goes only to OpenAI; undefined when there is none.
 * When `signal` aborts, or the time limit passes, the read ends: during the
 * refresh it stops waiting for it, and the request is cancelled.
 */
export async function chatgptUsage(models: Pick<Models, "getAuth">, id: string, fetcher: typeof fetch = fetch,
  limitMs: number = READ_LIMIT_MS, signal?: AbortSignal): Promise<UsageResponse | undefined> {
  const stop = new AbortController();
  const timer = setTimeout(() => { stop.abort(); }, limitMs);
  let stopped = false;
  const onAbort = (): void => { stopped = true; stop.abort(); };
  // pi-ai's refresh takes no signal: the read stops waiting for it instead.
  const ended = new Promise<never>((_, reject) => {
    stop.signal.addEventListener("abort", () => {
      reject(new Error(stopped ? "the read was stopped" : "the ChatGPT sign-in did not refresh in time"));
    }, { once: true });
  });
  ended.catch(() => undefined);
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (stopped) throw new Error("the read was stopped");
    const token = (await Promise.race([models.getAuth(id), ended]))?.auth.apiKey;
    if (token === undefined || token.length === 0) return undefined;
    const account = chatgptAccount(token);
    let response: Response;
    try {
      response = await fetcher(codexUrl, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "tesota",
        ...account === undefined ? {} : { "ChatGPT-Account-Id": account } }, signal: stop.signal });
    } catch { throw new Error(stopped ? "the read was stopped" : "could not reach chatgpt.com"); }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Where the panel's readings come from. */
export function usageSources(models: Pick<Models, "getAuth">): UsageSources {
  return { claudeCode: (folder, signal) => claudeCodeReport(folder, undefined, READ_LIMIT_MS, signal),
    chatgpt: (id, signal) => chatgptUsage(models, id, fetch, READ_LIMIT_MS, signal) };
}
