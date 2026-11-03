import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBase } from "../src/base.ts";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createSession, openSession } from "../src/session.ts";
import { readSessionFile, SessionFileError, sessionFormat, sessionVersion } from "../src/session-file.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-selected-model-"));
  roots.push(root);
  mkdirSync(join(root, "models"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/counter.ts"), "export const count = 0;\n");
  writeFileSync(join(root, "models/Counter.tla"), "(* tesota-model\n covers: src/counter.ts\n invariant: Safe\n atomic: each increment\n omits: crashes\n fault: models/Fault.cfg lock removed\n*)\n---- MODULE Counter ----\nSafe == TRUE\n====\n");
  writeFileSync(join(root, "models/Counter.cfg"), "INVARIANT Safe\n");
  writeFileSync(join(root, "models/Fault.cfg"), "INVARIANT Safe\nCONSTANT Locked = FALSE\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"], { cwd: root });
  return root;
}

test("pins the operator-selected model and its fault inputs before work (#791)", async () => {
  const root = repository();
  const base = await captureBase(root, undefined, "models/Counter.tla");
  expect(base.requiredModel?.path).toBe("models/Counter.tla");
  expect(base.requiredModel?.files).toEqual(["models/Counter.tla", "models/Counter.cfg", "models/Fault.cfg"]);
  expect(base.requiredModel?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  const selected = JSON.stringify(base.requiredModel);
  writeFileSync(join(root, "models/Fault.cfg"), "INVARIANT Safe\nCONSTANT Locked = TRUE\n");
  expect(JSON.stringify(base.requiredModel)).toBe(selected);
  expect((await captureBase(root, undefined, "models/Counter.tla")).requiredModel?.contentHash).not.toBe(base.requiredModel?.contentHash);
  expect(readFileSync(join(root, "src/counter.ts"), "utf8")).toContain("count = 0");
});

test("records --require-model identity before a session tool replaces its fault (#791)", async () => {
  const root = repository();
  const initial = await captureBase(root, undefined, "models/Counter.tla");
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "models/Fault.cfg", content: "INVARIANT Safe\nCONSTANT Locked = TRUE\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const folder = mkdtempSync(join(tmpdir(), "tesota-selected-model-session-"));
  roots.push(folder);
  const session = createSession({ cwd: root, folder, models, model: provider.getModel(), flags: { "require-model": "models/Counter.tla" },
    verifier: (pi) => { pi.registerFlag("require-model", { type: "string" }); pi.on("agent_before_settle", () => undefined); } });
  try {
    await session.prompt("Keep the selected lock-removal check while changing the code.");
    expect(session.ledger()[0]?.base.requiredModel).toEqual(initial.requiredModel);
    expect((await captureBase(root, undefined, "models/Counter.tla")).requiredModel?.contentHash).not.toBe(session.ledger()[0]?.base.requiredModel?.contentHash);
  } finally { await session.dispose(); }
});

test("keeps the admitted selection across follow-ups and resume without the option (#791)", async () => {
  const root = repository();
  const initial = await captureBase(root, undefined, "models/Counter.tla");
  const provider = fauxProvider();
  provider.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
  const models = createModels();
  models.setProvider(provider.provider);
  const folder = mkdtempSync(join(tmpdir(), "tesota-selected-model-resume-"));
  roots.push(folder);
  const verifier = (pi: import("../../../src/contract.ts").ExtensionAPI) => {
    pi.registerFlag("require-model", { type: "string" }); pi.on("agent_before_settle", () => undefined);
  };
  const session = createSession({ cwd: root, folder, models, model: provider.getModel(), flags: { "require-model": "models/Counter.tla" }, verifier });
  try {
    await session.prompt("Keep the selected model.");
    writeFileSync(join(root, "models/Fault.cfg"), "INVARIANT Safe\nCONSTANT Locked = TRUE\n");
    await session.prompt("Continue working.");
    expect(session.ledger()[1]?.base.requiredModel).toEqual(initial.requiredModel);
  } finally { await session.dispose(); }
  const resumed = openSession(session.file, { models, model: provider.getModel(), verifier });
  try {
    await resumed.prompt("Finish the same work.");
    expect(resumed.ledger()[2]?.base.requiredModel).toEqual(initial.requiredModel);
  } finally { await resumed.dispose(); }
  expect(() => openSession(session.file, { models, model: provider.getModel(), verifier,
    flags: { "require-model": "models/Other.tla" } })).toThrow();
  const afterRefusal = openSession(session.file, { models, model: provider.getModel(), verifier });
  await afterRefusal.dispose();
});

test("rejects a malformed pinned identity when reading the journal (#791)", async () => {
  const root = repository();
  const base = await captureBase(root, undefined, "models/Counter.tla");
  const file = join(root, "malformed.jsonl");
  const at = new Date().toISOString();
  writeFileSync(file, [
    { type: "session", format: sessionFormat, version: sessionVersion, id: "malformed", cwd: root, createdAt: at },
    { type: "request", run: 1, text: "Keep the selected check", origin: "interactive", at,
      base: { ...base, requiredModel: { ...base.requiredModel, files: [42] } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  expect(() => readSessionFile(file)).toThrow(SessionFileError);
});

test("preserves the pinned selection through compaction rather than recapturing a replacement (#791)", async () => {
  const root = repository();
  const initial = await captureBase(root, undefined, "models/Counter.tla");
  const provider = fauxProvider({ models: [{ id: "selection", contextWindow: 100_000 }] });
  let writes = 0;
  const response: FauxResponseStep = (context) => {
    const last = context.messages.at(-1)?.content;
    if (typeof last === "string" && /summary contract|Update the previous summary/u.test(last)) return fauxAssistantMessage("Keep the original selected model inputs.");
    if (writes < 3) {
      const path = `notes-${writes++}.txt`;
      return fauxAssistantMessage([fauxToolCall("write", { path, content: "A long tool call for compaction. ".repeat(1000) })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("done");
  };
  provider.setResponses(Array.from({ length: 24 }, () => response));
  const models = createModels();
  models.setProvider(provider.provider);
  const folder = mkdtempSync(join(tmpdir(), "tesota-selected-model-compact-"));
  roots.push(folder);
  const session = createSession({ cwd: root, folder, models, model: provider.getModel(), compaction: { reserve: 1000, keep: 100 },
    flags: { "require-model": "models/Counter.tla" },
    verifier: (pi) => { pi.registerFlag("require-model", { type: "string" }); pi.on("agent_before_settle", () => undefined); } });
  try {
    await session.prompt("Keep the selected model and write notes.");
    writeFileSync(join(root, "models/Fault.cfg"), "INVARIANT Safe\nCONSTANT Locked = TRUE\n");
    await session.compact();
    expect(readSessionFile(session.file).entries.some((entry) => entry.type === "compaction")).toBe(true);
    await session.prompt("Continue after compaction.");
    expect(session.ledger()[1]?.base.requiredModel).toEqual(initial.requiredModel);
    expect(session.history().some((message) => message.role === "custom" && typeof message.content === "string"
      && message.content.includes(initial.requiredModel?.contentHash ?? "missing"))).toBe(true);
  } finally { await session.dispose(); }
});

test("refuses missing or outside model inputs before an agent can run (#791)", async () => {
  const root = repository();
  await expect(captureBase(root, undefined, "../outside.tla")).rejects.toThrow("inside the project");
  rmSync(join(root, "models/Fault.cfg"));
  await expect(captureBase(root, undefined, "models/Counter.tla")).rejects.toThrow();
});

test("routes one --require-model option and refuses silently replacing a repeated option (#791)", () => {
  const root = repository();
  const main = join(import.meta.dir, "../src/main.ts");
  const selected = spawnSync(process.execPath, [main, "--require-model", "models/Counter.tla", "--version"], { cwd: root, encoding: "utf8" });
  expect(selected.status).toBe(0);
  const repeated = spawnSync(process.execPath, [main, "--require-model", "models/Counter.tla", "--require-model", "models/Other.tla", "--version"], { cwd: root, encoding: "utf8" });
  expect(repeated.status).not.toBe(0);
});
