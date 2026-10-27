import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "../src/session.ts";
import { readSessionFile } from "../src/session-file.ts";
import { accepts } from "./scripted.ts";

function start(script: readonly FauxResponseStep[]) {
  const provider = fauxProvider();
  provider.setResponses([...script]);
  const models = createModels();
  models.setProvider(provider.provider);
  const cwd = mkdtempSync(join(tmpdir(), "tesota-retry-"));
  return createSession({ cwd, folder: join(cwd, "sessions"), models, model: provider.getModel(), verifier: accepts });
}

for (const status of [429, 503]) test(`${status} then success retries visibly on the same model without replaying a tool`, async () => {
  let calls = 0;
  const session = start([
    fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
    () => { calls++; return fauxAssistantMessage([], { stopReason: "error", errorMessage: `${status}: temporarily unavailable` }); },
    () => { calls++; return fauxAssistantMessage("recovered"); },
  ]);
  const events: string[] = [];
  session.subscribe((event) => { if (event.type === "note") events.push(event.text); });
  try {
    await session.prompt("Read once and answer");
    expect(session.outcome()).toBe("completed");
    expect(calls).toBe(2);
    expect(events.join("\n")).toContain("Retry");
    expect(session.messages().filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(new Set(readSessionFile(session.file).entries.flatMap((entry) => entry.type === "assistant" ? [`${entry.message.provider}/${entry.message.model}`] : [])).size).toBe(1);
  } finally { await session.dispose(); }
});

test("the initial failure plus three failed retries ends with the provider reason", async () => {
  let calls = 0;
  const failure = () => { calls++; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503: still unavailable" }); };
  const session = start([failure, failure, failure, failure, fauxAssistantMessage("must not be reached")]);
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("error");
    expect(calls).toBe(4);
    expect(readSessionFile(session.file).entries.findLast((entry) => entry.type === "run_end")).toMatchObject({ reason: "503: still unavailable" });
  } finally { await session.dispose(); }
});

for (const reason of [
  "429: FreeUsageLimitError: Free usage limit reached",
  "429: insufficient_quota",
  "429: credits exhausted",
  "503: spending limit reached",
  "429: plan exhausted",
  "429: You exceeded your current quota, please check your plan",
  "503: spending cap reached",
  "429: credits depleted",
  "401: authentication failed; try your request again",
  "403: permission denied; server error",
  "400: invalid request; 503 in user input",
]) test(`terminal provider error is never retried: ${reason}`, async () => {
  let calls = 0;
  const session = start([
    () => { calls++; return fauxAssistantMessage([], { stopReason: "error", errorMessage: reason }); },
    () => { calls++; return fauxAssistantMessage("must not be reached"); },
  ]);
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("error");
    expect(calls).toBe(1);
  } finally { await session.dispose(); }
});

for (const retryAfter of ["121", new Date(Date.now() + 300_000).toUTCString()]) test(`Retry-After beyond the window stops at once: ${retryAfter}`, async () => {
  let calls = 0;
  const session = start([
    async (_context, options, _state, model) => {
      calls++;
      await options?.onResponse?.({ status: 429, headers: { "Retry-After": retryAfter } }, model);
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429: rate limited" });
    },
    () => { calls++; return fauxAssistantMessage("must not be reached"); },
  ]);
  const notes: string[] = [];
  session.subscribe((event) => { if (event.type === "note") notes.push(event.text); });
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("error");
    expect(calls).toBe(1);
    expect(notes).toEqual([]);
  } finally { await session.dispose(); }
});

test("cancel during the visible countdown stops before the next provider call", async () => {
  let calls = 0;
  const session = start([
    () => { calls++; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503: unavailable" }); },
    () => { calls++; return fauxAssistantMessage("must not be reached"); },
  ]);
  let countdown = false;
  session.subscribe((event) => {
    if (event.type === "retry" && event.delayMs > 0) { countdown = true; void session.abort(); }
  });
  try {
    await session.prompt("Answer");
    expect(countdown).toBe(true);
    expect(session.outcome()).toBe("aborted");
    expect(calls).toBe(1);
  } finally { await session.dispose(); }
});

test("a retried partial failure keeps its usage and diagnostic, not its content in the next request", async () => {
  let seen = "";
  const session = start([
    fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503: stream ended before message_stop" }),
    (context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("done"); },
  ]);
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("completed");
    expect(session.stats().tokens.output).toBe(3);
    expect(seen).not.toContain("partial");
    expect(readSessionFile(session.file).entries.find((entry) => entry.type === "custom" && entry.customType === "tesota.providerRetry")).toMatchObject({
      data: { attempt: 1, delayMs: 1000, message: { errorMessage: "503: stream ended before message_stop" } },
    });
  } finally { await session.dispose(); }
});

for (const [status, text, code] of [
  [529, "opaque provider response", "overloaded_error"],
  [0, "fetch failed", "ECONNRESET"],
] as const) test(`structured evidence and transport failures recover: ${code}`, async () => {
  let calls = 0;
  const session = start([
    async (_context, options, _state, model) => {
      calls++;
      await options?.onResponse?.({ status, headers: {} }, model);
      return { ...fauxAssistantMessage([], { stopReason: "error", errorMessage: text }), diagnostics: [
        { type: "provider_failure", timestamp: Date.now(), details: { status, errorCode: code } },
      ] };
    },
    () => { calls++; return fauxAssistantMessage("recovered"); },
  ]);
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("completed");
    expect(calls).toBe(2);
  } finally { await session.dispose(); }
});

test("scheduler overshoot stops without another call or counting failed usage twice", async () => {
  const now = performance.now.bind(performance);
  let overshot = false;
  const clock = spyOn(performance, "now").mockImplementation(() => now() + (overshot ? 120_001 : 0));
  let calls = 0;
  const session = start([
    () => { calls++; return fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503: unavailable" }); },
    () => { calls++; return fauxAssistantMessage("must not be reached"); },
  ]);
  session.subscribe((event) => { if (event.type === "retry" && event.delayMs > 0) overshot = true; });
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("error");
    expect(calls).toBe(1);
    expect(session.stats().tokens.output).toBe(2);
  } finally { clock.mockRestore(); await session.dispose(); }
});

test("resuming keeps retry usage but not the failed reply in model history", async () => {
  const provider = fauxProvider();
  let seen = "";
  provider.setResponses([
    fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503: unavailable" }),
    fauxAssistantMessage("done"),
    (context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("continued"); },
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const cwd = mkdtempSync(join(tmpdir(), "tesota-retry-resume-"));
  const options = { models, model: provider.getModel(), verifier: accepts };
  const session = createSession({ cwd, folder: join(cwd, "sessions"), ...options });
  try { await session.prompt("Answer"); } finally { await session.dispose(); }
  const resumed = openSession(session.file, options);
  try {
    expect(resumed.stats().tokens.output).toBe(3);
    await resumed.prompt("Continue");
    expect(resumed.outcome()).toBe("completed");
    expect(seen).not.toContain("partial");
    expect(seen).toContain("done");
  } finally { await resumed.dispose(); }
});
