import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { entryReceipt } from "../../../src/receipt.ts";
import { runPrint } from "../src/print.ts";
import { createSession, sessionsFolder } from "../src/session.ts";
import { accepts } from "./scripted.ts";
import { readSessionFile, type SessionEntry } from "../src/session-file.ts";
import { writeSettings } from "../src/settings.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply } from "./scripted.ts";

/**
 * `tesota -p -c` and `tesota -p --resume <id>` (#651): a print run that
 * ended on an unresolved question continues with the answer, and any other
 * session takes the text as a follow-up.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const held: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of held.splice(0)) { child.kill("SIGKILL"); await child.exited; }
});

const questions = [{ question: "Which file name should I use?", options: [
  { label: "a.txt", description: "Name it a.txt." }, { label: "b.txt", description: "Name it b.txt." },
] }];

/** A Git repository with one commit, where print mode runs. */
function repository(): string {
  const cwd = folder("tesota-resume-project-");
  const git = (...args: string[]): void => {
    const ran = spawnSync("git", ["-c", "user.name=Tesota", "-c", "user.email=tesota@example.test", ...args], { cwd, encoding: "utf8" });
    if (ran.status !== 0) throw new Error(ran.stderr);
  };
  git("init", "-q");
  writeFileSync(join(cwd, "README.md"), "project\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  return cwd;
}

/** Print mode on one scripted model across its runs, with full access so its writes run, and no model listing open cases. */
function printer(script: readonly ScriptStep[]): (args: readonly string[], cwd: string) => Promise<{ code: number; out: string; error: string }> {
  const provider = fauxProvider();
  provider.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(provider.provider);
  const model = provider.getModel();
  const settingsPath = join(folder("tesota-resume-settings-"), "settings.json");
  writeSettings({ model: `${model.provider}/${model.id}`, permissionMode: "full" }, settingsPath);
  return async (args, cwd) => {
    let out = "";
    let error = "";
    const code = await runPrint(args, cwd, { out: (text) => { out += text; }, error: (text) => { error += text; } },
      { "open-cases-model": "off" }, settingsPath, models);
    return { code, out, error };
  };
}

/** The sessions of `cwd`'s folder. */
const sessionsOf = (cwd: string): string[] => {
  try { return readdirSync(sessionsFolder(cwd)).filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionsFolder(cwd), name)); } catch { return []; }
};

const ofRun = (entries: readonly SessionEntry[], run: number): SessionEntry[] => entries.filter((entry) => "run" in entry && entry.run === run);
const receiptsOf = (entries: readonly SessionEntry[], run: number): unknown[] =>
  ofRun(entries, run).flatMap((entry) => { const receipt = entryReceipt(entry); return receipt === undefined ? [] : [receipt]; });

/** A run that writes a file, then asks which name to use, which print mode cannot answer. */
const asking: ScriptStep[] = [
  { tool: "write", args: { path: "a.txt", content: "draft\n" } },
  { tool: "ask_user", args: { questions } },
];

describe("resuming a print run that ended on a question", () => {
  for (const how of ["--resume", "-c"] as const) {
    test(`${how} answers it: the same session grows, the answer is a clarification, and the request continues from its base`, async () => {
      const cwd = repository();
      let seen = "";
      const print = printer([...asking, { seen: (context) => { seen = JSON.stringify(context.messages); }, reply: "Named it a.txt." }]);
      const first = await print(["Ask me which file name to use, then create that file"], cwd);
      expect(first.code).toBe(1);
      const [file] = sessionsOf(cwd);
      if (file === undefined) throw new Error("No session was written");
      const id = basename(file, ".jsonl");
      expect(first.error).toContain(`Awaiting your answer: tesota -p --resume ${id} "<answer>"`);
      // The question reads as a question, with its choices, not as JSON (#713).
      expect(first.error).toContain("The agent wanted to ask you something before going on:\n  Which file name should I use?\n    - a.txt: Name it a.txt.");
      const before = statSync(file).size;

      const second = await print(how === "-c" ? ["-c", "Use a.txt."] : ["--resume", id, "Use a.txt."], cwd);
      expect(second.error).not.toContain("Awaiting your answer");
      expect(second.code).toBe(0);
      expect(sessionsOf(cwd)).toEqual([file]);
      expect(statSync(file).size).toBeGreaterThan(before);

      const { entries } = readSessionFile(file);
      const [asked, continued] = entries.filter((entry) => entry.type === "request");
      expect(continued).toMatchObject({ run: 2, base: asked?.base });
      expect(continued?.type === "request" && continued.text.startsWith("Ask me which file name to use, then create that file")).toBe(true);
      expect(continued?.type === "request" && continued.text).toContain("continues request 1");
      // The answer is the operator's clarification of the batch that was left open, and the model hears it.
      const clarification = { questions, answers: [{ selected: [], text: "Use a.txt." }] };
      expect(ofRun(entries, 2)).toContainEqual(expect.objectContaining({ type: "custom", customType: "tesota.continues",
        data: { run: 1, clarification: expect.objectContaining(clarification) } }));
      expect(seen).toContain("Operator text (verbatim):\\nUse a.txt.");
      // The question's run settled once with its receipt; the continued run verifies once, at the request's real end.
      expect(receiptsOf(entries, 1)).toEqual([expect.objectContaining({ unresolvedQuestion: expect.stringContaining("Unresolved question") })]);
      expect(ofRun(entries, 2).filter((entry) => entry.type === "settled" && entry.phase === "verifier")).toHaveLength(1);
      const receipts = receiptsOf(entries, 2);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ clarifications: [expect.objectContaining(clarification)] });
      // What the run changed before its question is the request's own, since its start fingerprints were restored.
      expect(JSON.stringify((receipts[0] as { changed: unknown }).changed)).toContain("a.txt");
      expect(receipts[0]).not.toMatchObject({ inherited: [expect.objectContaining({ path: "a.txt" })] });
      expect(entries.findLast((entry) => entry.type === "run_end")).toMatchObject({ run: 2, outcome: "completed" });
    });
  }

  test("a prose question is answered as a batch of that one question", async () => {
    const cwd = repository();
    const print = printer(["Which file name should I use?", "Named it a.txt."]);
    expect((await print(["Create a file"], cwd)).code).toBe(1);
    const [file] = sessionsOf(cwd);
    if (file === undefined) throw new Error("No session was written");
    expect((await print(["--resume", basename(file, ".jsonl"), "Use a.txt."], cwd)).code).toBe(0);
    expect(ofRun(readSessionFile(file).entries, 2)).toContainEqual(expect.objectContaining({ type: "custom", customType: "tesota.continues",
      data: { run: 1, clarification: expect.objectContaining({ questions: [{ question: "Which file name should I use?", options: [] }],
        answers: [{ selected: [], text: "Use a.txt." }] }) } }));
  });

  test("resuming twice with the same text answers once; the second is a follow-up", async () => {
    const cwd = repository();
    const print = printer([...asking, "Named it a.txt.", "Already done."]);
    await print(["Ask me which file name to use, then create that file"], cwd);
    const [file] = sessionsOf(cwd);
    if (file === undefined) throw new Error("No session was written");
    const id = basename(file, ".jsonl");
    await print(["--resume", id, "Use a.txt."], cwd);
    await print(["--resume", id, "Use a.txt."], cwd);
    const { entries } = readSessionFile(file);
    expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "tesota.continues")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "request").at(-1)).toMatchObject({ run: 3, text: "Use a.txt." });
  });
});

describe("what the continued request carries", () => {
  test("an amendment given before the question stays part of the request, before the answer", async () => {
    const provider = fauxProvider();
    provider.setResponses([{ tool: "ask_user", args: { questions } }, "Named it a.txt."].map((step) => scriptedReply(step as ScriptStep)));
    const registry = createModels();
    registry.setProvider(provider.provider);
    const session = createSession({ cwd: repository(), folder: folder("tesota-resume-sessions-"), models: registry,
      model: provider.getModel(), verifier: accepts, mode: "print" });
    try {
      const asked = session.prompt("Create a file");
      await session.prompt("Do not touch README.md.", { streamingBehavior: "steer" });
      await asked;
      expect(session.ledger()[0]?.inputs.map((input) => input.kind)).toEqual(["amendment"]);
      await session.reply("Use a.txt.");
      expect(session.ledger()[1]?.inputs).toEqual([
        { kind: "amendment", origin: "interactive", text: "Do not touch README.md." },
        expect.objectContaining({ kind: "clarification" }),
      ]);
    } finally { await session.dispose(); }
  });

  test("a question with malformed arguments is answered as a prose question, and the ending still says how", async () => {
    const cwd = repository();
    const print = printer([{ tool: "ask_user", args: { questions: "Which file name?" } }, "Named it a.txt."]);
    const first = await print(["Create a file"], cwd);
    const [file] = sessionsOf(cwd);
    if (file === undefined) throw new Error("No session was written");
    const id = basename(file, ".jsonl");
    expect(first.error).toContain(`Awaiting your answer: tesota -p --resume ${id} "<answer>"`);
    expect((await print(["--resume", id, "Use a.txt."], cwd)).code).toBe(0);
    expect(ofRun(readSessionFile(file).entries, 2)).toContainEqual(expect.objectContaining({ customType: "tesota.continues",
      data: { run: 1, clarification: expect.objectContaining({ callId: "", answers: [{ selected: [], text: "Use a.txt." }],
        questions: [{ question: expect.stringContaining("Which file name?"), options: [] }] }) } }));
  });
});

describe("the final line's standing (#668)", () => {
  test("a run that creates an empty file, with nothing to verify it, never ends verified (#651)", async () => {
    const ended = await printer([{ tool: "write", args: { path: "notes.txt", content: "" } }, "Created notes.txt."])(
      ["Create an empty file named notes.txt"], repository());
    expect(ended.error).not.toContain(", verified");
    // It says why, as the receipt recorded it: the change holds no code.
    expect(ended.error).toContain("Completed, unverified: the changes are comments or blank lines only; tesota receipt writes it");
  });

  test("a read-only run, or a question, ends Completed, with nothing to verify", async () => {
    const cwd = repository();
    const read = await printer([{ tool: "read", args: { path: "README.md" } }, "It says project."])(["What does README.md say?"], cwd);
    expect(read.error).toContain("Completed.\n");
    const asked = await printer(["Two."])(["What is one plus one?"], cwd);
    expect(asked.error).toContain("Completed.\n");
    for (const { error } of [read, asked]) expect(error).not.toContain("verified");
  });
});

describe("resuming a session without a question", () => {
  test("the text is a follow-up: a new request, as the shell sends one", async () => {
    const cwd = repository();
    const print = printer(["Done.", "Done again."]);
    expect((await print(["Say done"], cwd)).code).toBe(0);
    const [file] = sessionsOf(cwd);
    if (file === undefined) throw new Error("No session was written");
    const second = await print(["--resume", basename(file, ".jsonl"), "Say it again"], cwd);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Done again.");
    const { entries } = readSessionFile(file);
    expect(entries.filter((entry) => entry.type === "request").map((entry) => entry.type === "request" ? entry.text : "")).toEqual(["Say done", "Say it again"]);
    expect(entries.some((entry) => entry.type === "custom" && entry.customType === "tesota.continues")).toBe(false);
  });
});

describe("what resuming refuses", () => {
  test("a session another process holds open, with the lock's message", async () => {
    const cwd = repository();
    const print = printer(["Done."]);
    await print(["Say done"], cwd);
    const [file] = sessionsOf(cwd);
    if (file === undefined) throw new Error("No session was written");
    const holder = Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), "hold", file], { stdout: "pipe", stderr: "inherit" });
    held.push(holder);
    let printed = "";
    for await (const chunk of holder.stdout) { printed += new TextDecoder().decode(chunk); if (printed.includes("opened")) break; }
    const refused = await print(["--resume", basename(file, ".jsonl"), "Go on"], cwd);
    expect(refused.code).not.toBe(0);
    expect(refused.error).toContain("The session is open in another writer");
    expect(refused.error).toContain("close it there first");
  });

  test("-c with no session in this folder", async () => {
    const refused = await printer([])(["-c", "Go on"], repository());
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("No session in this folder to continue");
  });

  test("an unknown id", async () => {
    const refused = await printer([])(["--resume", "2026-01-01T00-00-00-000Z-0000beef", "Go on"], repository());
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("No session 2026-01-01T00-00-00-000Z-0000beef in this folder");
  });

  test("-c together with --resume", async () => {
    const refused = await printer([])(["-c", "--resume", "some-id", "Go on"], repository());
    expect(refused.code).toBe(2);
    expect(refused.error).toContain("-c and --resume");
  });
});

test("print output and its piped sinks and session log contain no terminal mark", async () => {
  const cwd = repository();
  const print = printer(["An ordinary answer."]);
  const result = await print(["Answer without changing files."], cwd);
  expect(result.code).toBe(0);
  expect(result.out).toContain("An ordinary answer.");
  expect(result.out + result.error).not.toMatch(/[▀▄█⠁-⣿]/u);
  for (const file of sessionsOf(cwd)) {
    expect(JSON.stringify(readSessionFile(file).entries)).not.toMatch(/[▀▄█⠁-⣿]/u);
  }
});
