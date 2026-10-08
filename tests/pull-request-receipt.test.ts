import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { contentHash } from "../src/evidence.js";
import { httpsRepository, type PiSessions, receiptCommand } from "../src/pull-request-receipt.js";
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

/** A repository with `src/rule.ts` committed, an `origin` on GitHub and an operator's email. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-receipt-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "rule.ts"), rule);
  git(root, "init", "-q");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "user.name", "Operator");
  git(root, "remote", "add", "origin", "git@github.com:example/project.git");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

/** A receipt whose one proof checked `src/rule.ts` as `rule` holds it. */
function provedReceipt(base: string): Receipt {
  const files = ["src/rule.ts"];
  return { ...emptyReceipt, base, model: "provider/model", proofs: [{ path: "src/rule.ts", verdict: "proved", evidence: {
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
  const sessionId = session(root, { ...emptyReceipt, base }, provedReceipt(base));
  const markdown = tesota(root);
  expect(markdown.stderr).toBe("");
  expect(markdown.status).toBe(0);
  expect(markdown.stdout).toContain(`Commit \`${commit.slice(0, 12)}\`, changes from \`${base.slice(0, 12)}\`; Pi 1.1.0, ` +
    `model \`provider/model\`; session \`${sessionId}\``);
  expect(markdown.stdout).toContain("```text\nTesota receipt\n  proved        src/rule.ts\n");
  expect(markdown.stdout).toContain("  not verified  src/rule.ts lines 4-6: outside the contracts that proved");
  expect(markdown.stdout).not.toContain("Not this commit's content");
  expect(markdown.stdout).toContain("This is check evidence, not a reviewer's acceptance.");
  const json = tesota(root, "--json");
  expect(json.status).toBe(0);
  const statement = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(statement).toMatchObject({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ uri: `git+https://github.com/example/project@${commit}`, digest: { gitCommit: commit } }],
    predicateType: "https://github.com/sequelcore/tesota/receipt/v1",
    predicate: {
      providers: [{ harness: { name: "pi", version: "1.1.0" }, languageModels: [{ inferenceProvider: "provider/model" }] }],
      traceId: sessionId,
      custom: { baseCommit: { uri: `git+https://github.com/example/project@${base}`, digest: { gitCommit: base } },
        receipt: provedReceipt(base), stale: [] },
      result: "COMPLETED",
      owner: "operator@example.com",
      startTimestamp: emptyReceipt.startedAt,
      endTimestamp: emptyReceipt.settledAt,
    },
    createdBy: "tesota",
  });
  expect(Number.isNaN(Date.parse(String(statement["createdAt"])))).toBe(false);
}, 120_000);

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
  expect(output.pop()).toContain("tesota receipt takes only --json, not --markdown.");
});

it("reads a repository's HTTPS URL from its origin remote, however it is written", () => {
  expect(httpsRepository("git@github.com:sequelcore/tesota.git\n")).toBe("https://github.com/sequelcore/tesota");
  expect(httpsRepository("https://github.com/sequelcore/tesota.git")).toBe("https://github.com/sequelcore/tesota");
  expect(httpsRepository("https://token@github.com/sequelcore/tesota")).toBe("https://github.com/sequelcore/tesota");
  expect(httpsRepository("ssh://git@gitlab.example.com:2222/group/sub/project.git")).toBe("https://gitlab.example.com/group/sub/project");
  expect(httpsRepository("C:/repos/project")).toBeUndefined();
  expect(httpsRepository("/srv/git/project.git")).toBeUndefined();
});
