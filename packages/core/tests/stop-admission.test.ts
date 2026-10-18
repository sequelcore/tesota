import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, type EngineSession, type SessionOptions } from "../src/session.ts";
import { accepts, scriptedReply } from "./scripted.ts";

const open: EngineSession[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

function session(responses: readonly FauxResponseStep[], options: Partial<SessionOptions> = {}): EngineSession {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  const created = createSession({ cwd: mkdtempSync(join(tmpdir(), "tesota-core-admission-")),
    folder: mkdtempSync(join(tmpdir(), "tesota-core-sessions-")), models, model: faux.getModel(), verifier: accepts, ...options });
  open.push(created);
  return created;
}

test("a prompt stopped while waiting for startup is refused before it runs; a later prompt runs", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inputs: string[] = [];
  const created = session([
    scriptedReply({ tool: "write", args: { path: "ran.md", content: "ran" } }), scriptedReply("done"),
  ], { extensions: [(pi) => {
    pi.on("session_start", async () => { entered.resolve(); await release.promise; });
    pi.on("input", (event) => { inputs.push(event.text); });
  }] });
  const pending = created.prompt("go").catch((error: unknown) => error);
  try {
    await entered.promise;
    await created.abort();
  } finally { release.resolve(); }
  const refused = await pending;
  expect(existsSync(join(created.workspace.cwd, "ran.md"))).toBe(false);
  expect(refused).toMatchObject({ message: "the operator stopped the run" });
  expect(inputs).toEqual([]);
  expect(created.messages()).toEqual([]);
  expect(created.ledger()).toEqual([]);
  expect(readFileSync(created.file, "utf8").trimEnd().split("\n")).toHaveLength(1);
  expect(created.outcome()).toBeUndefined();

  await created.prompt("after the stop");
  expect(inputs).toEqual(["after the stop"]);
  expect(readFileSync(join(created.workspace.cwd, "ran.md"), "utf8")).toBe("ran");
  expect(created.ledger().map(({ run, text }) => ({ run, text }))).toEqual([{ run: 1, text: "after the stop" }]);
  expect(created.outcome()).toBe("completed");
});

test("a prompt stopped while waiting for manual compaction is refused; a prompt after the stop runs", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inputs: string[] = [];
  const created = session([
    ...Array.from({ length: 3 }, (_, k) => scriptedReply({ tool: "write", args: { path: `note-${k}.txt`, content: "note ".repeat(300) } })),
    scriptedReply("done"),
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("## Goal\nwrite notes"); },
    scriptedReply({ tool: "write", args: { path: "ran.md", content: "ran" } }), scriptedReply("done"),
  ], { compaction: { reserve: 1_000, keep: 600 }, extensions: [(pi) => {
    pi.on("input", (event) => { inputs.push(event.text); });
  }] });
  await created.prompt("write notes");
  const compacting = created.compact().catch((error: unknown) => error);
  await entered.promise;
  const before = readFileSync(created.file, "utf8");
  const pending = created.prompt("go").catch((error: unknown) => error);
  // Startup has finished; let the prompt enter its compaction wait before stopping it.
  await Promise.resolve();
  const stopping = created.abort();
  release.resolve();
  await stopping;
  expect(await compacting).toMatchObject({ message: "the operator stopped the run" });
  const refused = await pending;
  expect(existsSync(join(created.workspace.cwd, "ran.md"))).toBe(false);
  expect(refused).toMatchObject({ message: "the operator stopped the run" });
  expect(inputs).toEqual(["write notes"]);
  expect(created.ledger().map(({ text }) => text)).toEqual(["write notes"]);
  // The stopped summary may record its usage, but the refused prompt adds no run to the file.
  expect(readFileSync(created.file, "utf8").slice(before.length).trimEnd().split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["summary_usage"]);
  expect(created.outcome()).toBe("completed");

  await created.prompt("after the stop");
  expect(inputs).toEqual(["write notes", "after the stop"]);
  expect(readFileSync(join(created.workspace.cwd, "ran.md"), "utf8")).toBe("ran");
  expect(created.ledger().map(({ run, text }) => ({ run, text }))).toEqual([
    { run: 1, text: "write notes" }, { run: 2, text: "after the stop" },
  ]);
  expect(created.outcome()).toBe("completed");
});
