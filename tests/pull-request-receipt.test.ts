import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { contentHash } from "../src/evidence.js";
import { httpsRepository, type PiSessions, receiptCommand, subjectOf } from "../src/pull-request-receipt.js";
import type { Receipt } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

// The end-to-end test runs the built launcher, `dist/cli.js`; `bun run test` builds it first.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  return { ...emptyReceipt, base, model: "provider/model", changed, proofs: [{ path: "src/rule.ts", verdict: "proved", evidence: {
    verifier: "lemmascript", claim: "", limits: "", outcome: "passed", output: "1 verified, 0 errors", durationMs: 1, files,
    contentHash: contentHash([{ path: "src/rule.ts", content: rule }]) } }],
  uncovered: [{ path: "src/rule.ts", lines: [[4, 6]] }] };
}

/** A Pi session in `root` whose requests settled with `receipts`, written as Pi writes one. */
function session(root: string, ...receipts: unknown[]): string {
  const manager = SessionManager.create(root);
  for (const receipt of receipts) {
    manager.appendMessage({ role: "user", content: "fix it", timestamp: Date.now() });
    manager.appendCustomMessageEntry("tesota-receipt", "Tesota receipt", true, receipt);
  }
  return manager.getSessionId();
}

function tesota(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [resolve("dist/cli.js"), "receipt", ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
}

it("writes the last receipt for a pull request as Markdown and as an in-toto Statement about the commit", () => {
  const root = repository();
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the change");
  const commit = git(root, "rev-parse", "HEAD");
  const changed = [{ path: "notes.md", blob: git(root, "hash-object", "notes.md") }];
  const sessionId = session(root, { ...emptyReceipt, base }, provedReceipt(base, changed));
  const markdown = tesota(root);
  expect(markdown.stderr).toBe("");
  expect(markdown.status).toBe(0);
  expect(markdown.stdout).toContain(`Commit \`${commit.slice(0, 12)}\`, changes from \`${base.slice(0, 12)}\`; Pi 1.1.0, ` +
    `model \`provider/model\`; session \`${sessionId}\``);
  expect(markdown.stdout).toContain("```text\nTesota receipt\n  proved        src/rule.ts\n");
  expect(markdown.stdout).toContain("  not verified  src/rule.ts lines 4-6: outside the contracts that proved");
  expect(markdown.stdout).not.toContain("Not this commit's content");
  expect(markdown.stdout).not.toContain("Changed after the receipt");
  expect(markdown.stdout).toContain("This is check evidence, not a reviewer's acceptance.");
  const json = tesota(root, "--json");
  expect(json.status).toBe(0);
  const statement = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(statement).toMatchObject({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ uri: `git+https://github.com/example/project@${commit}`, digest: { gitCommit: commit } }],
    predicateType: "https://github.com/sequelcore/tesota/blob/main/docs/receipt-v1.md",
    predicate: {
      providers: [{ harness: { name: "pi", version: "1.1.0" }, languageModels: [{ inferenceProvider: "provider/model" }] }],
      traceId: sessionId,
      custom: { baseCommit: { uri: `git+https://github.com/example/project@${base}`, digest: { gitCommit: base } },
        receipt: provedReceipt(base, changed), stale: [], changedAfter: [] },
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

it("says which evidence the commit no longer holds, committed or not", () => {
  const root = repository();
  session(root, provedReceipt(git(root, "rev-parse", "HEAD")));
  writeFileSync(join(root, "src", "rule.ts"), `${rule}// edited\n`);
  const uncommitted = tesota(root);
  expect(uncommitted.stdout).toContain("**Not this commit's content:** what these checked has changed since they ran: `src/rule.ts`.");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "edited after the proof");
  expect(JSON.parse(tesota(root, "--json").stdout)).toMatchObject({ predicate: { custom: { stale: ["src/rule.ts"] } } });
}, 120_000);

it("refuses without a receipt this Tesota reads, or with arguments it does not take", async () => {
  const output: string[] = [];
  const write = { out: (text: string) => { output.push(text); }, error: (text: string) => { output.push(text); } };
  const none: PiSessions = { list: () => Promise.resolve([]), open: () => { throw new Error("no session to open"); } };
  expect(await receiptCommand([], "here", none, write)).toBe(1);
  expect(output.pop()).toContain("No Pi session in this folder settled with a Tesota receipt.");
  const old: PiSessions = { list: () => Promise.resolve([{ path: "old", modified: new Date() }]),
    open: () => ({ getSessionId: () => "id", getBranch: () => [{ type: "custom_message", customType: "tesota-receipt",
      details: { version: 0, repository: true } }] }) };
  expect(await receiptCommand([], "here", old, write)).toBe(1);
  expect(output.pop()).toContain("The last receipt here came from an earlier Tesota");
  expect(await receiptCommand(["--markdown"], "here", old, write)).toBe(2);
  expect(output.pop()).toContain("tesota receipt takes --json and --owner <login or email>, not --markdown.");
  expect(await receiptCommand(["--owner", "--json"], "here", old, write)).toBe(2);
  expect(output.pop()).toContain("not --owner.");
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
  session(workspace, { ...emptyReceipt, repository: true, base: null, units: [{ ...provedReceipt(base), folder: "api" },
    { ...emptyReceipt, folder: "notes", repository: false }] });
  const output: string[] = [];
  const write = { out: (text: string) => { output.push(text); }, error: (text: string) => { output.push(text); } };
  expect(await receiptCommand([], root, SessionManager, write)).toBe(0);
  const markdown = output.pop() ?? "";
  expect(markdown).toContain(`changes from \`${base.slice(0, 12)}\``);
  expect(markdown).toContain("  proved        src/rule.ts");
  expect(markdown).not.toContain("notes");
  expect(await receiptCommand([], workspace, SessionManager, write)).toBe(1);
  expect(output.pop()).toContain("The last receipt here covers several repositories.");
});
