import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntryDraft } from "../../../src/contract.ts";
import { contentHash } from "../../../src/evidence.ts";
import { httpsRepository, receiptCommand, receiptMarkdown, type SessionStore, subjectOf } from "../../../src/pull-request-receipt.ts";
import type { Receipt } from "../../../src/receipt.ts";
import { emptyReceipt } from "../../../tests/receipts.ts";
import { createSession } from "../src/session.ts";
import { sessionStore } from "../src/session-store.ts";
import { scriptedReply } from "./scripted.ts";

/** `tesota receipt` (#463): the last receipt of the engine's sessions in a folder, for a pull request. */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

it("explains request attribution, inherited paths and capture limits in pull-request Markdown", () => {
  const receipt: Receipt = { ...emptyReceipt, inherited: ["old.txt"],
    startState: { status: "unknown", reason: "the index has unresolved conflicts" },
    unmeasured: [{ path: "large.bin", reason: "file exceeds 10 MiB" }] };
  const markdown = receiptMarkdown(receipt, { commit: "1234567890123456", owner: "operator", sessionId: "session", stale: [], changedAfter: [] });
  expect(markdown).toContain("history moved, could not be read, or was not captured");
  expect(markdown).toContain("test exercise, contract strength and ClaimCheck were not measured");
  expect(markdown).toContain("old.txt");
  expect(markdown).toContain("the index has unresolved conflicts");
  expect(markdown).toContain("large.bin: file exceeds 10 MiB");
  expect(markdown).toContain("exercise test relying on them may be misjudged");
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

const rule = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

/** A new empty folder, removed after the test. */
function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-receipt-"));
  roots.push(root);
  return root;
}

/** A repository with `src/rule.ts` committed, an `origin` on GitHub and an operator's email, in `root` or a new folder. */
function repository(root = folder()): string {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "rule.ts"), rule);
  git(root, "init", "-q");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "user.name", "Operator");
  git(root, "remote", "add", "origin", "git@github.com:example/project.git");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

/** A receipt whose one proof checked `src/rule.ts` as `rule` holds it, and whose run left `changed`. */
function provedReceipt(base: string, changed: Receipt["changed"] = []): Receipt {
  const files = ["src/rule.ts"];
  return { ...emptyReceipt, base, startState: { status: "known", head: base }, endState: { status: "known", head: base },
    model: "provider/model", changed, proofs: [{ path: "src/rule.ts", verdict: "proved", evidence: {
    verifier: "lemmascript", claim: "", limits: "", outcome: "passed", output: "1 verified, 0 errors", durationMs: 1, files,
    contentHash: contentHash([{ path: "src/rule.ts", content: rule }]) } }],
  uncovered: [{ path: "src/rule.ts", lines: [[4, 6]] }] };
}

/** `provedReceipt` with every changed line under a contract, so it stands verified. */
function verifiedReceipt(base: string, changed: Receipt["changed"] = []): Receipt {
  return { ...provedReceipt(base, changed), uncovered: [] };
}

/** A session store holding one session whose branch settled with `receipt`. */
function holding(receipt: unknown): SessionStore {
  return { list: () => Promise.resolve([{ path: "one", modified: new Date() }]),
    open: () => ({ getSessionId: () => "id", getBranch: () => [{ type: "custom_message", customType: "tesota-receipt", details: receipt }] }) };
}

/** A scripted model giving `replies`, for a session. */
function scripted(replies: readonly Parameters<typeof scriptedReply>[0][]) {
  const faux = fauxProvider();
  faux.setResponses(replies.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() };
}

/**
 * An engine session in `root` with one request per receipt, each settled by
 * a verifier that records it as Tesota does: as a message, or as a custom
 * entry in print mode (#427). Returns the session's id.
 */
async function session(root: string, receipts: readonly unknown[], kept: "message" | "entry" = "message"): Promise<string> {
  const created = createSession({ cwd: root, ...scripted(receipts.map(() => "done")), verifier: recording(receipts, kept) });
  for (const _ of receipts) await created.prompt("fix it");
  await created.dispose();
  return basename(created.file, ".jsonl");
}

/** A verifier that settles each run with the next of `receipts`, as Tesota records one. */
function recording(receipts: readonly unknown[], kept: "message" | "entry" = "message") {
  let settled = 0;
  return (pi: Parameters<Parameters<typeof createSession>[0]["verifier"]>[0]) => {
    pi.on("agent_before_settle", () => {
      const receipt = receipts[settled++];
      const entry: EntryDraft = kept === "message"
        ? { type: "custom_message", customType: "tesota-receipt", content: "Tesota receipt", display: true, details: receipt }
        : { type: "custom", customType: "tesota-receipt", data: receipt };
      return { entries: [entry] };
    });
  };
}

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * `tesota receipt` as its own process, in the home this one writes sessions
 * to: Bun on Linux keeps the home it started with, whatever the test's
 * isolated home says, and a new process would read the other one.
 */
function tesota(root: string, ...args: string[]) {
  const home = homedir();
  return spawnSync(process.execPath, [main, "receipt", ...args], { cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home } });
}

it("writes the last receipt for a pull request as Markdown and as an in-toto Statement about the commit", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the change");
  const commit = git(root, "rev-parse", "HEAD");
  const changed = [{ path: "notes.md", blob: git(root, "hash-object", "notes.md") }];
  const incomplete = await session(root, [{ ...emptyReceipt, base }, provedReceipt(base, changed)]);
  const markdown = tesota(root);
  expect(markdown.stderr).toBe("");
  expect(markdown.status).toBe(0);
  expect(markdown.stdout).toContain(`Commit \`${commit.slice(0, 12)}\`, changes from \`${base.slice(0, 12)}\`; Tesota 0.1.0, ` +
    `model \`provider/model\`; session \`${incomplete}\``);
  expect(markdown.stdout).toContain("```text\nTesota receipt\nNo review flags · 1 verification limit\nCheck evidence, not your acceptance.\n");
  expect(markdown.stdout).toContain("\nDetails\n  proved        src/rule.ts\n");
  expect(markdown.stdout).toContain("  not verified  src/rule.ts lines 4-6: outside the contracts that proved");
  expect(markdown.stdout).not.toContain("Not this commit's content");
  expect(markdown.stdout).not.toContain("Changed after the receipt");
  expect(markdown.stdout).toContain("This is check evidence, not a reviewer's acceptance.");
  // An incomplete receipt has no truthful process result, so it is not written as a Statement.
  const refused = tesota(root, "--json");
  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe("");
  const sessionId = await session(root, [verifiedReceipt(base, changed)]);
  const json = tesota(root, "--json");
  expect(json.status).toBe(0);
  const statement = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(statement).toMatchObject({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ uri: `git+https://github.com/example/project@${commit}`, digest: { gitCommit: commit } }],
    predicateType: "https://github.com/sequelcore/tesota/blob/main/docs/receipt-v2.md",
    predicate: {
      providers: [{ harness: { name: "tesota", version: "0.1.0" }, languageModels: [{ inferenceProvider: "provider/model" }] }],
      traceId: sessionId,
      custom: { baseCommit: { uri: `git+https://github.com/example/project@${base}`, digest: { gitCommit: base } },
        receipt: verifiedReceipt(base, changed), stale: [], changedAfter: [] },
      result: "COMPLETED",
      owner: "operator@example.com",
      startTimestamp: emptyReceipt.startedAt,
      endTimestamp: emptyReceipt.settledAt,
    },
    createdBy: "tesota",
  });
  expect(Number.isNaN(Date.parse(String(statement["createdAt"])))).toBe(false);
  expect(JSON.parse(tesota(root, "--json", "--owner", "octocat").stdout)).toMatchObject({ predicate: { owner: "octocat" } });
}, 120_000);

it("writes the receipt a print-mode run kept as a custom entry (#427)", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  const sessionId = await session(root, [{ ...emptyReceipt, base }], "entry");
  const markdown = tesota(root);
  expect(markdown.stderr).toBe("");
  expect(markdown.status).toBe(0);
  expect(markdown.stdout).toContain(`session \`${sessionId}\``);
}, 60_000);

it("lists the files the commit changed after the receipt, and not an uncommitted edit", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src", "new.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "kept.ts"), "export const b = 2;\n");
  rmSync(join(root, "src", "rule.ts"));
  const changed = [{ path: "src/kept.ts", blob: git(root, "hash-object", "src/kept.ts") },
    { path: "src/new.ts", blob: git(root, "hash-object", "src/new.ts") }, { path: "src/rule.ts", blob: null }];
  const receipt = { ...emptyReceipt, base, changed };
  writeFileSync(join(root, "src", "new.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "extra.md"), "# Added after\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the change, with more");
  writeFileSync(join(root, "src", "kept.ts"), "export const b = 3;\n");
  expect(await subjectOf(root, receipt, "id")).toMatchObject({ changedAfter: ["extra.md", "src/new.ts"] });
  expect(await subjectOf(root, { ...receipt, changed: "unreadable" }, "id")).toMatchObject({ changedAfter: "unreadable" });
  git(root, "config", "--unset", "user.email");
  expect(await subjectOf(root, receipt, "id")).toContain("set Git's user.email, or pass --owner");
  expect(await subjectOf(root, receipt, "id", "octocat")).toMatchObject({ owner: "octocat" });
});

it("says which evidence the commit no longer holds, committed or not", async () => {
  const root = repository();
  await session(root, [verifiedReceipt(git(root, "rev-parse", "HEAD"))]);
  writeFileSync(join(root, "src", "rule.ts"), `${rule}// edited\n`);
  const uncommitted = tesota(root);
  expect(uncommitted.stdout).toContain("**Not this commit's content:** what these checked has changed since they ran: `src/rule.ts`.");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "edited after the proof");
  // A Statement is written only when the commit holds exactly what the checks saw.
  const refused = tesota(root, "--json");
  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("what these checked changed after they ran: src/rule.ts.");
  expect(refused.stderr).toContain("Run the request again");
}, 120_000);

it("refuses to export a verified receipt whose commit holds files changed after the run, or when Git can't tell", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  const errors: string[] = [];
  const out: string[] = [];
  const write = { out: (text: string) => { out.push(text); }, error: (text: string) => { errors.push(text); } };
  expect(await receiptCommand(["--json"], root, holding(verifiedReceipt(base)), write)).toBe(0);
  writeFileSync(join(root, "extra.md"), "# Added after\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "more after the run");
  out.length = 0;
  expect(await receiptCommand(["--json"], root, holding(verifiedReceipt(base)), write)).toBe(1);
  expect(out).toEqual([]);
  expect(errors.pop()).toContain("These files changed after the run: extra.md.");
  expect(await receiptCommand(["--json"], root, holding(verifiedReceipt("f".repeat(40))), write)).toBe(1);
  expect(errors.pop()).toContain("Git could not tell which files this commit changed after the run");
  // The Markdown still says so, as it did.
  expect(await receiptCommand([], root, holding(verifiedReceipt(base)), write)).toBe(0);
  expect(out.pop()).toContain("**Changed after the receipt:**");
});

it("exports a receipt whose proving wrote its proof files once they are committed, and refuses a later edit to them (#737)", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  const proof = "// generated from src/rule.ts\n";
  for (const path of ["src/rule.dfy", "src/rule.dfy.gen"]) writeFileSync(join(root, path), proof);
  // As the gate records them: the files proving wrote are the run's changes, and the proof checked the source with its `.dfy`.
  const verified = verifiedReceipt(base, ["src/rule.dfy", "src/rule.dfy.gen"].map((path) => ({ path, blob: git(root, "hash-object", path) })));
  const receipt = { ...verified, proofs: verified.proofs.map((proved) => ({ ...proved, evidence: { ...proved.evidence,
    files: ["src/rule.ts", "src/rule.dfy"], contentHash: contentHash([{ path: "src/rule.ts", content: rule }, { path: "src/rule.dfy", content: proof }]) } })) };
  const errors: string[] = [];
  const write = { out: () => undefined, error: (text: string) => { errors.push(text); } };
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the change with its proof");
  expect(await receiptCommand(["--json"], root, holding(receipt), write)).toBe(0);
  writeFileSync(join(root, "src", "rule.dfy"), "// edited after the run\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "edited after the run");
  expect(await receiptCommand(["--json"], root, holding(receipt), write)).toBe(1);
  expect(errors.pop()).toContain("what these checked changed after they ran: src/rule.ts. These files changed after the run: src/rule.dfy.");
});

it("exports each standing with the result it observed, and refuses one no result states truthfully", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  const failedProof: Receipt = { ...provedReceipt(base), uncovered: [], unverified: ["src/rule.ts"],
    proofs: provedReceipt(base).proofs.map((proof) => ({ ...proof, verdict: "no_progress" as const,
      evidence: { ...proof.evidence, outcome: "failed" as const, output: "1 verified, 1 error" } })) };
  const notes: Receipt = { ...emptyReceipt, base, changed: [{ path: "notes.md", blob: null }], unverified: ["notes.md"] };
  const cases: [string, Receipt, string | undefined][] = [
    ["verified", verifiedReceipt(base), "COMPLETED"],
    ["unchanged", { ...emptyReceipt, base }, "COMPLETED"],
    ["failed", failedProof, "FAILED"],
    ["failed, with an unresolved question", { ...failedProof, unresolvedQuestion: "Which behavior?" }, "FAILED"],
    ["incomplete", provedReceipt(base), undefined],
    ["incomplete, with an unresolved question", { ...verifiedReceipt(base), unresolvedQuestion: "Which behavior?" }, undefined],
    ["unverified", notes, undefined],
  ];
  for (const [standing, receipt, result] of cases) {
    const out: string[] = [];
    const errors: string[] = [];
    const write = { out: (text: string) => { out.push(text); }, error: (text: string) => { errors.push(text); } };
    expect(await receiptCommand(["--json"], root, holding(receipt), write), standing).toBe(result === undefined ? 1 : 0);
    if (result === undefined) {
      expect(out, standing).toEqual([]);
      expect(errors.join(""), standing).toContain(`stands ${standing.split(",")[0]}`);
      expect(errors.join(""), standing).toContain("Run tesota receipt without --json");
    } else {
      expect(errors, standing).toEqual([]);
      expect(JSON.parse(out.join("")), standing).toMatchObject({ predicate: { result } });
    }
    // The Markdown says where the receipt stands in its own words, whatever it is.
    expect(await receiptCommand([], root, holding(receipt), write), standing).toBe(0);
  }
});

it("never exports FAILED for a design model that never ran, as one whose header names no invariant", async () => {
  const root = repository();
  const spec = "---- MODULE Rule ----\n====\n";
  mkdirSync(join(root, "models"));
  writeFileSync(join(root, "models", "Rule.tla"), spec);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "model");
  const base = git(root, "rev-parse", "HEAD");
  // As checkModel records a header it refuses before TLC starts: `malformed`, with an outcome of `failed` the gate sends back.
  const refused = { path: "models/Rule.tla", language: "tla", header: { covers: [{ path: "src/rule.ts", names: [] }], invariants: [],
    atomic: [], omits: [], faults: [] }, problems: ["its tesota-model header names no invariant"], run: "malformed", states: 0, faults: [],
    staleness: "current", stale: [], writtenWithCode: false, link: "no_replay", evidence: { verifier: "tlc", claim: "", limits: "",
      outcome: "failed", output: "its tesota-model header names no invariant", durationMs: 0, files: ["models/Rule.tla", "src/rule.ts"],
      contentHash: contentHash([{ path: "models/Rule.tla", content: spec }, { path: "src/rule.ts", content: rule }]) } };
  for (const verdict of ["send_back", "no_progress"] as const) {
    const receipt = { ...verifiedReceipt(base), models: [{ ...refused, verdict }] } as Receipt;
    // Its evidence is current, so only the standing decides the export.
    expect(await subjectOf(root, receipt, "id")).toMatchObject({ stale: [], changedAfter: [] });
    const out: string[] = [];
    const errors: string[] = [];
    const write = { out: (text: string) => { out.push(text); }, error: (text: string) => { errors.push(text); } };
    expect(await receiptCommand(["--json"], root, holding(receipt), write), verdict).toBe(1);
    expect(out, verdict).toEqual([]);
    expect(errors.join(""), verdict).toContain("stands incomplete");
    expect(await receiptCommand(["--json"], root, holding({ ...receipt, proofs: [] }), write), verdict).toBe(1);
    expect(errors.pop(), verdict).toContain("stands unverified");
  }
});

it("reports a design model stale when a file it covers changed after the run", async () => {
  const root = repository();
  const spec = "---- MODULE Rule ----\n====\n";
  mkdirSync(join(root, "models"));
  writeFileSync(join(root, "models", "Rule.tla"), spec);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "model");
  const base = git(root, "rev-parse", "HEAD");
  const files = ["models/Rule.tla", "src/rule.ts"];
  const model = { path: "models/Rule.tla", language: "tla", header: { covers: [{ path: "src/rule.ts", names: [] }], invariants: ["Safe"],
    atomic: [], omits: [], faults: [] }, problems: [], run: "passed", states: 9, faults: [], staleness: "current", stale: [],
    writtenWithCode: false, link: "no_replay", verdict: "proved", evidence: { verifier: "tlc", claim: "", limits: "", outcome: "passed",
      output: "", durationMs: 1, files, contentHash: contentHash([{ path: "models/Rule.tla", content: spec }, { path: "src/rule.ts", content: rule }]) } };
  const receipt = { ...verifiedReceipt(base), models: [model] } as Receipt;
  expect(await subjectOf(root, receipt, "id")).toMatchObject({ stale: [] });
  writeFileSync(join(root, "src", "rule.ts"), `${rule}// edited\n`);
  // Dirty in the checkout, and then committed.
  expect(await subjectOf(root, receipt, "id")).toMatchObject({ stale: ["src/rule.ts", "models/Rule.tla"] });
  git(root, "add", "-A");
  git(root, "commit", "-qm", "edited after the run");
  expect(await subjectOf(root, receipt, "id")).toMatchObject({ stale: ["src/rule.ts", "models/Rule.tla"] });
});

it("refuses without a receipt this Tesota reads, or with arguments it does not take", async () => {
  const output: string[] = [];
  const write = { out: (text: string) => { output.push(text); }, error: (text: string) => { output.push(text); } };
  const none: SessionStore = { list: () => Promise.resolve([]), open: () => { throw new Error("no session to open"); } };
  expect(await receiptCommand([], "here", none, write)).toBe(1);
  expect(output.pop()).toContain("No session in this folder settled with a Tesota receipt.");
  const old: SessionStore = { list: () => Promise.resolve([{ path: "old", modified: new Date() }]),
    open: () => ({ getSessionId: () => "id", getBranch: () => [{ type: "custom_message", customType: "tesota-receipt",
      details: { version: 0, repository: true } }] }) };
  expect(await receiptCommand([], "here", old, write)).toBe(1);
  expect(output.pop()).toContain("The last receipt here came from an earlier Tesota");
  expect(await receiptCommand(["--markdown"], "here", old, write)).toBe(2);
  expect(output.pop()).toContain("tesota receipt takes --json and --owner <login or email>, not --markdown.");
  expect(await receiptCommand(["--owner", "--json"], "here", old, write)).toBe(2);
  expect(output.pop()).toContain("not --owner.");
});

it("exports a receipt from a run that ended before verification as cancelled", async () => {
  const root = repository();
  const output: string[] = [];
  const errors: string[] = [];
  const write = { out: (text: string) => { output.push(text); }, error: (text: string) => { errors.push(text); } };
  const stopped = holding({ ...emptyReceipt, base: git(root, "rev-parse", "HEAD"), stopped: "quota exhausted" });
  expect(await receiptCommand(["--json"], root, stopped, write)).toBe(0);
  expect(errors).toEqual([]);
  expect(JSON.parse(output.pop() ?? "")).toMatchObject({ predicate: { result: "CANCELLED", custom: { receipt: { stopped: "quota exhausted" } } } });
  expect(await receiptCommand([], root, stopped, write)).toBe(0);
  expect(output.pop()).toContain("quota exhausted");
});

it("reads a repository's HTTPS URL from its origin remote, however it is written", () => {
  expect(httpsRepository("git@github.com:sequelcore/tesota.git\n")).toBe("https://github.com/sequelcore/tesota");
  expect(httpsRepository("https://github.com/sequelcore/tesota.git")).toBe("https://github.com/sequelcore/tesota");
  expect(httpsRepository("https://token@github.com/sequelcore/tesota")).toBe("https://github.com/sequelcore/tesota");
  expect(httpsRepository("ssh://git@gitlab.example.com:2222/group/sub/project.git")).toBe("https://gitlab.example.com/group/sub/project");
  expect(httpsRepository("C:/repos/project")).toBeUndefined();
  expect(httpsRepository("/srv/git/project.git")).toBeUndefined();
});

it("writes, in a repository of a folder of repositories, the part of that folder's receipt that covers it", async () => {
  const workspace = folder();
  const root = repository(join(workspace, "api"));
  const base = git(root, "rev-parse", "HEAD");
  await session(workspace, [{ ...emptyReceipt, repository: true, base: null, units: [{ ...provedReceipt(base), folder: "api" },
    { ...emptyReceipt, folder: "notes", repository: false }] }]);
  const output: string[] = [];
  const write = { out: (text: string) => { output.push(text); }, error: (text: string) => { output.push(text); } };
  expect(await receiptCommand([], root, sessionStore, write)).toBe(0);
  const markdown = output.pop() ?? "";
  expect(markdown).toContain(`changes from \`${base.slice(0, 12)}\``);
  expect(markdown).toContain("  proved        src/rule.ts");
  expect(markdown).not.toContain("notes");
  expect(await receiptCommand([], workspace, sessionStore, write)).toBe(1);
  expect(output.pop()).toContain("The last receipt here covers several repositories.");
});

it("exports, in a repository of a folder of repositories, its part of a stopped run's inventory only as it stands (#599)", async () => {
  const workspace = folder();
  const root = repository(join(workspace, "api"));
  const base = git(root, "rev-parse", "HEAD");
  await session(workspace, [{ ...emptyReceipt, repository: true, base: null, stopped: "the operator stopped the run",
    units: [{ ...emptyReceipt, folder: "api", base, changed: [{ path: "src/rule.ts", blob: null }] }] }]);
  const output: string[] = [];
  const write = { out: (text: string) => { output.push(text); }, error: (text: string) => { output.push(text); } };
  // Its inventory says the run deleted src/rule.ts, which the commit still holds: never a Statement.
  expect(await receiptCommand(["--json"], root, sessionStore, write)).toBe(1);
  expect(output.pop()).toContain("These files changed after the run: src/rule.ts.");
  expect(await receiptCommand([], root, sessionStore, write)).toBe(0);
  const markdown = output.pop() ?? "";
  expect(markdown).toContain("the operator stopped the run");
  expect(markdown).toContain("**Changed after the receipt:**");
});

it("leaves out a receipt whose run never ended, as when Tesota was killed after recording it", async () => {
  const root = repository();
  await session(root, [{ ...emptyReceipt, base: git(root, "rev-parse", "HEAD") }]);
  const [file] = await sessionStore.list(root);
  const lines = readFileSync(file?.path ?? "", "utf8").trimEnd().split("\n");
  writeFileSync(file?.path ?? "", `${lines.filter((line) => !line.includes('"run_end"')).join("\n")}\n`);
  const run = tesota(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("No session in this folder settled with a Tesota receipt.");
}, 60_000);

it("refuses a receipt from before the engine named itself, which has pi in place of engine", async () => {
  const root = repository();
  const { engine: _, ...older } = { ...emptyReceipt, base: git(root, "rev-parse", "HEAD") };
  await session(root, [{ ...older, pi: "1.3.0" }]);
  const run = tesota(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("The last receipt here came from an earlier Tesota");
}, 60_000);

it("writes a worktree session's receipt from its worktree, and never from the checkout another session holds", async () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  // The first session holds the checkout, so the second works in a worktree of its own (#453).
  const holder = createSession({ cwd: root, ...scripted([]), verifier: recording([]) });
  const other = createSession({ cwd: root, ...scripted([{ tool: "write", args: { path: "b.txt", content: "b" } }, "done"]),
    verifier: recording([{ ...emptyReceipt, base }]) });
  await other.prompt("add b");
  const worktree = other.workspace.cwd;
  expect(other.workspace.worktree).toBeDefined();
  await other.dispose();
  await holder.dispose();
  roots.push(worktree);
  git(worktree, "add", "-A");
  git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b");
  const there = tesota(worktree);
  expect(there.stderr).toBe("");
  expect(there.stdout).toContain(`session \`${basename(other.file, ".jsonl")}\``);
  expect(tesota(root).stderr).toContain("No session in this folder settled with a Tesota receipt.");
}, 120_000);

it("takes the verifier's flags with -p, and still asks for a request", () => {
  const run = spawnSync(process.execPath, [main, "-p", "--open-cases-model", "off"], { encoding: "utf8", timeout: 60_000 });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("Say what to do.");
  const unknown = spawnSync(process.execPath, [main, "--colour"], { encoding: "utf8", timeout: 60_000 });
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain("--open-cases-model");
});
