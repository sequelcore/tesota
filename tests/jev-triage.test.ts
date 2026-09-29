import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { jevDecision, jevRequests, jevTriage, typesafeKey } from "../src/integrations/jev-triage.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

/**
 * The answer check's first pass on Jev (decision 035): the two questions it
 * is asked, the registered threshold below which a turn is skipped, and every
 * failure counting as no decision, so the full check runs.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const kind = (conversation: unknown): unknown => ({ model: "jev-1.13.0", answers: { request: { type: "choice",
  choice: "conversation", probabilities: { change: 0, repository: 0, conversation }, confidence: 0.9 } } });
const claims = (noul: unknown): unknown => ({ model: "jev-1.13.0", answers: { claims: { type: "noul", noul } } });

it("asks the request's kind from the requests alone, and the reply's claims from both, as named fields", () => {
  const bodies = jevRequests("typesafe:jev-1.13.0", ["Add a farewell() helper", "thanks!"], "  ");
  expect(bodies.request).toMatchObject({ model: "jev-1.13.0", state: { user_requests: ["Add a farewell() helper", "thanks!"] },
    questions: { request: { type: "choice", criteria: { change: expect.any(String), repository: expect.any(String),
      conversation: expect.any(String) } } } });
  expect(JSON.stringify(bodies.request)).not.toContain("agent_reply");
  expect(bodies.claims).toMatchObject({ model: "jev-1.13.0",
    state: { user_requests: ["Add a farewell() helper", "thanks!"], agent_reply: "(empty)" }, questions: { claims: { type: "noul" } } });
});

it("skips a turn only when both answers fall below the registered threshold, and decides nothing without both", () => {
  expect(jevDecision(kind(0.95), claims(0.09))).toMatchObject({ decided: true, checkable: false, probability: 0.09 });
  // A confident reply cannot talk a question about the code out of its check.
  expect(jevDecision(kind(0.1), claims(0.05))).toMatchObject({ decided: true, checkable: true, probability: 0.9 });
  expect(jevDecision(kind(0.95), claims(0.75))).toMatchObject({ decided: true, checkable: true, probability: 0.75 });
  expect(jevDecision(kind(0.8), claims(0.1))).toMatchObject({ decided: true, checkable: true });
  for (const [request, reply] of [[kind(Number.NaN), claims(0.1)], [kind(0.9), claims(1.5)], [kind("0.9"), claims(0.1)],
    [{ answers: {} }, claims(0.1)], [kind(0.9), null], ["text", claims(0.1)]]) {
    expect(jevDecision(request, reply)).toMatchObject({ decided: false, checkable: true });
  }
});

it("decides nothing when TypeSafe refuses, cannot be reached, or does not answer in time", async () => {
  const signal = new AbortController().signal;
  const refused = vi.fn(async () => new Response("{}", { status: 401 }));
  expect(await jevTriage("key", "typesafe:jev-1.13.0", ["hi"], "Hello!", signal, 1_000, refused))
    .toEqual({ decided: false, checkable: true, reason: "Jev answered HTTP 401" });
  const unreachable = vi.fn(async () => { throw new TypeError("fetch failed"); });
  expect(await jevTriage("key", "typesafe:jev-1.13.0", ["hi"], "Hello!", signal, 1_000, unreachable))
    .toMatchObject({ decided: false, checkable: true });
  const silent = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_settle, fail) => {
    init?.signal?.addEventListener("abort", () => { fail(new DOMException("timed out", "TimeoutError")); });
  }));
  expect(await jevTriage("key", "typesafe:jev-1.13.0", ["hi"], "Hello!", signal, 20, silent as typeof fetch))
    .toMatchObject({ decided: false, checkable: true });
});

it("sends the key only in the authorization header, and reads Jev's probability", async () => {
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    Response.json(String(init?.body).includes("\"choice\"") ? kind(0.97) : claims(0.03)));
  const decision = await jevTriage("secret", "typesafe:jev-1.13.0", ["hi"], "Hello!", new AbortController().signal, 1_000, request);
  expect(decision).toMatchObject({ decided: true, checkable: false });
  expect(request).toHaveBeenCalledTimes(2);
  const [url, init] = request.mock.calls[0] ?? [];
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  expect(String(init?.body)).not.toContain("secret");
});

it("uses the saved TypeSafe key before TYPESAFE_API_KEY", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-typesafe-"));
  roots.push(root);
  const credentials = new TesotaCredentials(join(root, "auth"));
  expect(await typesafeKey(credentials, {})).toBeUndefined();
  expect(await typesafeKey(credentials, { TYPESAFE_API_KEY: " from-env " })).toBe("from-env");
  await credentials.modify("typesafe", async () => ({ type: "api_key", key: "saved" }));
  expect(await typesafeKey(credentials, { TYPESAFE_API_KEY: "from-env" })).toBe("saved");
});
