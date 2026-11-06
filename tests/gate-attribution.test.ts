import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { headCommit } from "../src/git.js";
import { suggestChecks } from "../src/projects.js";
import { receiptMarkdown, subjectOf } from "../src/pull-request-receipt.js";
import { receiptFindings, receiptSummary, renderReceipt, type Receipt } from "../src/receipt.js";
import { attributionResolved } from "../src/request-fingerprint.js";
import { commit, contract, credited, entry, gate, git, moveHistory, prepareIncoming, priceTest, project, scripted, testedProject, useGateHarness, write } from "./gate-harness.js";

vi.mock("../src/verification/lemmascript-verifier.js", async (original) =>
  (await import("./gate-harness.js")).lemmaScriptMock(original));
vi.mock("../src/model-check.js", async (original) =>
  (await import("./gate-harness.js")).modelCheckMock(original));

useGateHarness();

it.each(["tui", "print"])("fingerprints inherited dirt without verifying an unchanged shell request in %s", async (mode) => {
  const root = project();
  write(root, { "src/rule.ts": `${contract}// old\n` });
  const find = vi.fn();
  const run = gate(root, undefined, { mode, modelRegistry: { find }, flags: { "open-cases-model": undefined } });
  run.progress.ready("proofs_and_tests");
  await run.input();
  await run.tool("bash");
  expect(await run.settle()).toBeUndefined();
  expect(find).not.toHaveBeenCalled();
  expect(run.steps.some(({ step }) => step === "proving" || step === "testing")).toBe(false);
  expect(run.progress.status).toEqual({ step: "unchanged" });
});

it.each(["tui", "print"])("attributes only the request edit and preserves inherited files in %s", async (mode) => {
  const root = project();
  write(root, { "src/rule.ts": `${contract}// old\n`, "old.txt": "old\n" });
  const run = gate(root, undefined, { mode });
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "new\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: expect.any(String) }]);
  expect(receipt).toMatchObject({ inherited: ["old.txt", "src/rule.ts"], codeEvidence: { proofs: [], unverified: ["notes.md"] } });
});

it.each(["commit", "delete", "stash", "switch"])("makes a %s eligible even without a remaining worktree diff", async (action) => {
  const root = project();
  if (action === "switch") {
    git(root, "branch", "before");
    write(root, { "notes.md": "other branch\n" });
    commit(root, "other branch");
  }
  if (action === "stash") write(root, { "notes.md": "old dirt\n" });
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  if (action === "commit") { write(root, { "notes.md": "committed\n" }); commit(root, "agent commit"); }
  if (action === "delete") rmSync(join(root, "notes.md"));
  if (action === "stash") git(root, "-c", "user.name=t", "-c", "user.email=t@t", "stash");
  if (action === "switch") git(root, "switch", "before");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: action === "delete" ? null : expect.any(String) }]);
  expect(receipt).toMatchObject({ inherited: [] });
});

it("resolves attribution only for readable HEADs still at admission, including unborn repositories", () => {
  const known = (head: string | null) => ({ status: "known" as const, head });
  expect(attributionResolved("H", known("H"), known("H"), true)).toBe(true);
  expect(attributionResolved(null, known(null), known(null), true)).toBe(true);
  expect(attributionResolved("H", known("other"), known("H"), true)).toBe(false);
  expect(attributionResolved("H", known("H"), known("other"), true)).toBe(false);
  expect(attributionResolved("H", undefined, known("H"), true)).toBe(false);
  expect(attributionResolved("H", known("H"), undefined, true)).toBe(false);
  expect(attributionResolved("H", { status: "unknown", reason: "unreadable" }, known("H"), true)).toBe(false);
  expect(attributionResolved("snapshot", undefined, undefined, false)).toBe(true);
  const own = { sameBranch: true, descends: true, exclusive: true, timely: true };
  expect(attributionResolved("H", known("H"), { ...known("own"), history: own }, true)).toBe(true);
  for (const fact of ["sameBranch", "descends", "exclusive", "timely"] as const) {
    expect(attributionResolved("H", known("H"), { ...known("own"), history: { ...own, [fact]: false } }, true)).toBe(false);
  }
});

it.each(["merge", "merge-deleted", "remote", "fetch", "url", "switch", "rebase", "amend", "mixed", "pruned", "commit", "unchanged", "push", "subagent", "tag"])("attributes %s history and exports the settled checkout (#599)", async (action) => {
  const root = testedProject();
  git(root, "branch", "admission");
  git(root, "checkout", "-b", "upstream");
  write(root, { "test/imported.test.mjs": priceTest(1, 1, "imported"), "src/imported.ts": contract });
  git(root, "add", "-A");
  // A future committer date keeps the incoming commit timely, so each case isolates the fact it names (url backdates it).
  expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "upstream expectations"],
    { cwd: root, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z" } }).status).toBe(0);
  prepareIncoming(root, action);
  if (action === "rebase" || action === "merge" || action === "amend") { write(root, { "local.txt": "local\n" }); commit(root, "local before request"); }
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  moveHistory(root, action);
  // Local work on an imported path must remain visible, not be filtered as upstream.
  if (action === "merge") write(root, { "src/imported.ts": contract.replace("return 0", "return 2") });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.tests.some(({ evidence }) => evidence.outcome === "passed")).toBe(true);
  expect(receipt.codeEvidence.proofs.map(({ path }) => path)).toContain("src/imported.ts");
  expect(receipt.changed).toEqual(expect.arrayContaining([expect.objectContaining({ path: "test/imported.test.mjs" })]));
  const texts = [renderReceipt(receipt), receiptMarkdown(receipt, { commit: "abc", owner: "t", sessionId: action, stale: [], changedAfter: [] })];
  for (const text of texts) expect(text.match(/compared with the request's start/giu) ?? []).toHaveLength(credited.has(action) ? 0 : 1);
  if (credited.has(action)) {
    expect(receiptFindings(receipt).some(({ label }) => label === "Attribution unresolved")).toBe(false);
    expect(await subjectOf(root, receipt, action, "operator")).toMatchObject({ changedAfter: action === "unchanged" ? ["src/imported.ts", "test/imported.test.mjs"] : [] });
    expect(receipt.codeEvidence.exercises.length).toBeGreaterThan(0);
    expect(receipt.specificationEvidence.contracts.length).toBeGreaterThan(0);
  } else {
    expect(receipt.codeEvidence.exercises).toEqual([]);
    expect(receipt.specificationEvidence.contracts).toEqual([]);
    expect(receipt.requestReview.contractComparison.runs[0]).toBeUndefined();
    expect(run.progress.operations.operations().some(({ method }) =>
      method === "exercise" || method === "base_control" || method === "mutation" || method === "claimcheck")).toBe(false);
    expect(receiptSummary(receipt).limits.some(({ note, title }) => /history moved/u.test(note + title))).toBe(true);
    expect(receiptFindings(receipt)).toContainEqual(expect.objectContaining({ label: "Attribution unresolved" }));
    expect(renderReceipt(receipt)).toContain("history moved");
    const subject = await subjectOf(root, receipt, "history", "operator");
    // Export describes the committed content: include the overlapping local edit first.
    if (action === "merge") {
      expect(subject).toMatchObject({ changedAfter: ["src/imported.ts"] });
      commit(root, "include checked local edit");
      expect(await subjectOf(root, receipt, "history", "operator")).toMatchObject({ changedAfter: [] });
    } else expect(subject).toMatchObject({ changedAfter: [] });
    write(root, { "test/imported.test.mjs": priceTest(2, 2, "later edit") });
    commit(root, "edit after settlement");
    expect(await subjectOf(root, receipt, "history", "operator")).toMatchObject({ changedAfter: ["test/imported.test.mjs"] });
  }
});

it("keeps missing historical admission metadata unknown (#727)", async () => {
  const root = project();
  const commit = await headCommit(root);
  const run = gate(root, undefined, {}, () => ({ text: "Update notes.", at: "2026-11-02T00:00:00Z", inputs: [],
    base: { units: [{ folder: "", kind: "commit", commit }] } }));
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "# Changed\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(Object.hasOwn(receipt.codeEvidence, "checksAtStart")).toBe(false);
});

it.each([true, false])("credits the request's commits only when the ledger recorded the starting refs (recorded: %s, #599)", async (recordedRefs) => {
  const root = testedProject();
  const commitId = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const refs = spawnSync("git", ["for-each-ref", "--format=%(objectname)"], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n");
  const at = new Date().toISOString();
  const run = gate(root, undefined, {}, () => ({ text: "fix it", at, inputs: [],
    base: { units: [{ folder: "", kind: "commit", commit: commitId, ...recordedRefs ? { refs } : {} }], checks: [{ folder: "", projects: suggestChecks(root) }] } }));
  await run.input();
  await run.tool("bash");
  write(root, { "test/imported.test.mjs": priceTest(1, 1, "imported") });
  commit(root, "the request's commit");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.tests[0]?.evidence.outcome).toBe("passed");
  expect(receiptFindings(receipt).some(({ label }) => label === "Attribution unresolved")).toBe(!recordedRefs);
  expect(receipt.codeEvidence.exercises.length > 0).toBe(recordedRefs);
});

it("keeps history that moved between admission and the first tool in scope (#599)", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  write(root, { "test/imported.test.mjs": priceTest(1, 1, "imported") });
  commit(root, "history before first tool capture");
  await run.tool("bash");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toContainEqual({ path: "test/imported.test.mjs", blob: expect.any(String) });
  expect(receipt.codeEvidence.tests[0]?.evidence.outcome).toBe("passed");
  expect(receipt.codeEvidence.exercises).toEqual([]);
  expect(renderReceipt(receipt)).toContain("history moved");
});

it("qualifies the #612 branch-switch deletion against the request's start (#599)", async () => {
  const root = testedProject();
  git(root, "branch", "before612");
  write(root, { "test/home.test.mjs": priceTest(1, 1, "home") });
  commit(root, "612 home isolation");
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  git(root, "switch", "before612");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toContainEqual({ path: "test/home.test.mjs", blob: null });
  expect(receipt.codeEvidence.exercises).toEqual([]);
  expect(receipt.codeEvidence.tests[0]?.evidence.outcome).toBe("passed");
  const finding = receiptFindings(receipt).find(({ check }) => check === "weakening");
  expect(finding?.detail).not.toContain("compared with the request's start");
  for (const text of [renderReceipt(receipt), receiptMarkdown(receipt, { commit: "abc", owner: "t", sessionId: "switch", stale: [], changedAfter: [] })]) {
    expect(text).toContain("compared with the request's start");
    expect(text).not.toContain("this request deleted");
    expect(text.match(/history moved/gu)).toHaveLength(1);
  }
  expect(await subjectOf(root, receipt, "switch", "t")).toMatchObject({ changedAfter: [] });
});

it("keeps earlier stopped weakening against H when a new request edits another file", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/price.test.mjs": "// stopped request removed the test\n" });
  await run.settle("aborted");
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "new request\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: expect.any(String) }]);
  expect(receipt).toMatchObject({ inherited: ["test/price.test.mjs"], codeEvidence: { exercises: [] } });
  expect(Array.isArray(receipt.specificationEvidence.weakened) && receipt.specificationEvidence.weakened.some(({ path }) => path === "test/price.test.mjs")).toBe(true);
  expect(receiptFindings(receipt)).toContainEqual(expect.objectContaining({ standing: "decide", check: "weakening" }));
});

it("measures from the commit the request started at, so an agent's commit hides nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  commit(root, "agent");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
  scripted.delete("src/rule.ts");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
  expect(receipt.codeEvidence.unverified).toEqual(["notes.md"]);
  await run.input();
  expect(await run.settle()).toBeUndefined();
});

it("keeps the running request's base through a steer or follow-up sent after the agent committed", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  commit(root, "agent");
  await run.input("interactive", "steer");
  await run.input("interactive", "followUp");
  expect((entry(await run.settle()).details as Receipt).codeEvidence.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
});
