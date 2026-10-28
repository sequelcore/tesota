import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, spyOn, test } from "bun:test";
import { filesTouched, summarize, summaryMessage, type SummaryRequest } from "../src/compaction.ts";
import type { HistoryMessage } from "../src/loop.ts";

test("files are strings, unique, ordered by first appearance, and changed takes precedence", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "read pretend.txt", timestamp: 0 },
    fauxAssistantMessage([
      fauxToolCall("read", { path: "first.txt" }),
      fauxToolCall("read", { path: "read.txt" }),
      fauxToolCall("write", { path: "written.txt" }),
      fauxToolCall("edit", { path: "edited.txt" }),
      fauxToolCall("edit", { path: "first.txt" }),
      fauxToolCall("read", { path: "written.txt" }),
      fauxToolCall("write", { path: "written.txt" }),
      fauxToolCall("read", { path: "read.txt" }),
      fauxToolCall("read", { path: "last.txt" }),
      fauxToolCall("read", { path: 42 }),
      fauxToolCall("write", { path: null }),
      fauxToolCall("edit", { path: ["ignored.txt"] }),
      fauxToolCall("read", {}),
      fauxToolCall("bash", { path: "ignored.txt" }),
    ]),
  ];
  expect(filesTouched(history)).toEqual({ read: ["read.txt", "last.txt"], changed: ["first.txt", "written.txt", "edited.txt"] });
  expect(filesTouched([])).toEqual({ read: [], changed: [] });
});

function scripted(responses: FauxResponseStep[], overrides: Partial<SummaryRequest> = {}) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const request: SummaryRequest = {
    cwd: process.cwd(), models, model: faux.getModel(), previous: undefined, messages: [],
    files: { read: [], changed: [] }, signal: new AbortController().signal, ...overrides,
  };
  return { faux, request };
}

test("the model receives the fixed contract and a single text transcript with bounded tool results, each clip marked", async () => {
  const signal = new AbortController().signal;
  const { faux, request } = scripted([(context, options) => {
    expect(options?.signal).toBe(signal);
    expect(options?.metadata).toEqual({ cwd: "session-worktree" });
    expect(context.messages).toHaveLength(2);
    const [system, user] = context.messages;
    if (system?.role !== "system" || typeof system.content !== "string" || user?.role !== "user") throw new Error("Expected system and user messages");
    expect(system.content.match(/^## .*$/gmu)).toEqual([
      "## Goal", "## Requirements", "## Decisions", "## Progress", "## Open items",
    ]);
    expect(system.toolsAdded ?? []).toEqual([]);
    // #623: the clip is the transcript's own, so the summary must not call it a cut at the source.
    expect(system.content).toContain("[clipped for this summary: ...]");
    expect(system.content).toContain("Never report such a result as cut off at its source");
    expect(user.content).toBe([
      "system: Earlier instructions",
      "user: Keep the wording",
      'assistant: Working on it\ntoolCall read (call-1): {"path":"input.txt"}',
      "toolResult read (call-1): " + "a".repeat(2000) + " [clipped for this summary: 2000 of 2006 characters shown]",
      "toolResult read (call-2, error): " + "b".repeat(2000) + " [clipped for this summary: 2000 of 2007 characters shown]",
      "toolResult read (call-3): " + "c".repeat(2000),
      "user: Verifier feedback",
      "",
      "Write a summary of the transcript above following the summary contract.",
    ].join("\n\n"));
    return fauxAssistantMessage([{ type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "  compact summary  " }]);
  }], { cwd: "session-worktree", signal, messages: [
    { role: "system", content: "Earlier instructions", timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "Keep the wording" }], timestamp: 0 },
    fauxAssistantMessage([{ type: "text", text: "Working on it" }, fauxToolCall("read", { path: "input.txt" }, { id: "call-1" })]),
    { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "a".repeat(2000) + "omit a" }], isError: false, timestamp: 0 },
    { role: "toolResult", toolName: "read", toolCallId: "call-2", content: [{ type: "text", text: "b".repeat(2000) }, { type: "text", text: "omit b" }], isError: true, timestamp: 0 },
    { role: "toolResult", toolName: "read", toolCallId: "call-3", content: [{ type: "text", text: "c".repeat(2000) }], isError: false, timestamp: 0 },
    { role: "custom", customType: "feedback", content: "Verifier feedback", display: false, timestamp: 0 },
  ] });
  expect(await summarize(request)).toMatchObject({ summary: "compact summary" });
  expect(faux.state.callCount).toBe(1);
});

test("a previous summary is merged with new messages instead of rewritten", async () => {
  const { faux, request } = scripted([(context) => {
    const user = context.messages.find((message) => message.role === "user");
    expect(user?.content).toBe([
      "Previous summary:\n## Goal\nKeep the old goal",
      "user: Add a new requirement",
      "",
      "Update the previous summary with the new messages above, keeping everything still true. Merge, rather than rewrite from scratch.",
    ].join("\n\n"));
    return fauxAssistantMessage("updated summary");
  }], { previous: "## Goal\nKeep the old goal", messages: [{ role: "user", content: "Add a new requirement", timestamp: 0 }] });
  expect(await summarize(request)).toMatchObject({ summary: "updated summary" });
  expect(faux.state.callCount).toBe(1);
});

for (const stopReason of ["error", "aborted"] as const) {
  test("a provider result ending with " + stopReason + " returns an error without retrying", async () => {
    const { faux, request } = scripted([fauxAssistantMessage("partial summary", { stopReason, errorMessage: "provider failed" })]);
    expect(await summarize(request)).toMatchObject({ error: "provider failed" });
    expect(faux.state.callCount).toBe(1);
  });
}

test("a provider exception returns an error without retrying", async () => {
  const { faux, request } = scripted([() => { throw new Error("provider threw"); }]);
  expect(await summarize(request)).toMatchObject({ error: "provider threw" });
  expect(faux.state.callCount).toBe(1);
});

test("an aborted signal returns an error", async () => {
  const { request } = scripted([fauxAssistantMessage("should not become a summary")], { signal: AbortSignal.abort() });
  expect(await summarize(request)).toMatchObject({ error: expect.any(String) });
});

test("an empty reply returns an error without retrying", async () => {
  const { faux, request } = scripted([fauxAssistantMessage(" \n\t ")]);
  expect(await summarize(request)).toMatchObject({ error: "Summary reply was empty." });
  expect(faux.state.callCount).toBe(1);
});

test("the replacement message lists only the file groups that are present", () => {
  const prefix = "This is a summary of the earlier conversation.\n\n## Goal\nContinue the work";
  expect(summaryMessage("## Goal\nContinue the work", { read: [], changed: [] })).toBe(prefix);
  expect(summaryMessage("## Goal\nContinue the work", { read: ["input.txt", "notes.md"], changed: [] }))
    .toBe(prefix + "\n\nFiles read:\n- input.txt\n- notes.md");
  expect(summaryMessage("## Goal\nContinue the work", { read: [], changed: ["output.txt"] }))
    .toBe(prefix + "\n\nFiles changed:\n- output.txt");
  expect(summaryMessage("## Goal\nContinue the work", { read: ["input.txt"], changed: ["output.txt"] }))
    .toBe(prefix + "\n\nFiles read:\n- input.txt\n\nFiles changed:\n- output.txt");
});

test("a synchronous stream exception returns an error without retrying", async () => {
  const { request } = scripted([]);
  const stream = spyOn(request.models, "streamSimple").mockImplementation(() => { throw new Error("stream failed"); });
  try {
    expect(await summarize(request)).toMatchObject({ error: "stream failed" });
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    stream.mockRestore();
  }
});
