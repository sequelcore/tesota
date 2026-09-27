import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { jevDecision, jevRequest, jevTriage, typesafeKey } from "../src/integrations/jev-triage.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

/**
 * The answer check's first pass on Jev (decision 035): the question it is
 * asked, the registered threshold below which a turn is skipped, and every
 * failure counting as no decision, so the full check runs.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const answer = (noul: unknown): unknown => ({ model: "jev-1.13.0", answers: { checkable: { type: "noul", noul } } });

it("asks the pinned model about the requests and the reply, as named fields", () => {
  expect(jevRequest("typesafe:jev-1.13.0", ["Add a farewell() helper", "thanks!"], "  ")).toMatchObject({
    model: "jev-1.13.0",
    state: { user_requests: ["Add a farewell() helper", "thanks!"], agent_reply: "(empty)" },
    questions: { checkable: { type: "noul" } },
  });
});

it("skips a turn only below the registered threshold, and decides nothing without a probability", () => {
  expect(jevDecision(answer(0.09))).toMatchObject({ decided: true, checkable: false });
  expect(jevDecision(answer(0.2))).toMatchObject({ decided: true, checkable: true });
  expect(jevDecision(answer(0.5))).toMatchObject({ decided: true, checkable: true });
  for (const body of [answer(Number.NaN), answer(-0.1), answer(1.5), answer("0.1"), { answers: {} }, null, "text"]) {
    expect(jevDecision(body)).toMatchObject({ decided: false, checkable: true });
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
  const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(answer(0.03)));
  const decision = await jevTriage("secret", "typesafe:jev-1.13.0", ["hi"], "Hello!", new AbortController().signal, 1_000, request);
  expect(decision).toMatchObject({ decided: true, checkable: false });
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
