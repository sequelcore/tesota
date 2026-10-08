import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UsageSources } from "../account-usage.js";
import { AUTH_ROUTES, claudeCodeExecutable, routeAccount } from "../auth.js";
import { claudeCodeRouteDirectory, piRuntime, tesotaUserAgent } from "./model-session.js";
import { TesotaCredentials } from "./tesota-credentials.js";

/** How long one provider may take to answer before its read counts as failed. */
const READ_TIME_LIMIT_MS = 20_000;

/**
 * A route's key or token through Pi, which refreshes a ChatGPT sign-in that
 * expired and reads a key from its environment variable when none is saved.
 */
async function routeKey(route: string, provider: string, credentials: TesotaCredentials): Promise<string | undefined> {
  // Each kind's default route keeps its credential in Tesota's store; an added route in its own file (decision 050).
  const store = (AUTH_ROUTES as readonly string[]).includes(route) ? credentials : TesotaCredentials.forRoute(route, provider);
  const runtime = await piRuntime(store);
  const key = (await runtime.getAuth(provider))?.auth.apiKey;
  return key === undefined || key.length === 0 ? undefined : key;
}

async function get(url: string, headers: Readonly<Record<string, string>>): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try { response = await fetch(url, { headers, signal: AbortSignal.timeout(READ_TIME_LIMIT_MS) }); } catch {
    throw new Error(`could not reach ${new URL(url).host}`);
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
}

/**
 * Claude Code's own report of an account's plan limits, read without sending
 * a request: the SDK's experimental usage call on a conversation that is
 * never given a message. It needs Claude Code's ordinary traffic, which a
 * working session turns off, or the limits come back empty.
 */
async function claudeCodeReport(configDirectory: string | undefined): Promise<unknown> {
  const idle = new AbortController();
  // A conversation that ends, with no message, only when the report is in.
  const nothing: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
      idle.signal.addEventListener("abort", () => { resolve({ done: true, value: undefined }); }, { once: true });
    }),
  }) };
  const session = query({ prompt: nothing, options: { pathToClaudeCodeExecutable: claudeCodeExecutable(), settingSources: [],
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "tesota", ...configDirectory === undefined ? {} : { CLAUDE_CONFIG_DIR: configDirectory } } } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Claude Code did not report its usage in time")); },
        READ_TIME_LIMIT_MS); })]);
  } finally {
    clearTimeout(timer);
    idle.abort();
    session.close();
  }
}

/** Where `tesota usage` and `/usage` read from. */
export function usageSources(credentials: TesotaCredentials = new TesotaCredentials()): UsageSources {
  return { key: (route, provider) => routeKey(route, provider, credentials), get, claudeCode: claudeCodeReport,
    claudeCodeDirectory: claudeCodeRouteDirectory, account: async (route, kind) => (await routeAccount(route, kind, credentials))?.id,
    userAgent: tesotaUserAgent() };
}
