import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { changedFiles, STOP_INVENTORY_TIME_LIMIT_MS, type SentBack } from "../src/gate.js";
import { headCommit } from "../src/git.js";
import { receiptFindings, receiptStanding, receiptSummary, type Receipt } from "../src/receipt.js";
import { commit, contract, entry, facts, folder, gate, git, plainProject, priceTest, project, repository, roots, scripted, testedProject, useGateHarness, workspace, write, type Settled } from "./gate-harness.js";
import { hangingFilter } from "./hanging-git.js";

vi.mock("../src/verification/lemmascript-verifier.js", async (original) =>
  (await import("./gate-harness.js")).lemmaScriptMock(original));
vi.mock("../src/model-check.js", async (original) =>
  (await import("./gate-harness.js")).modelCheckMock(original));

useGateHarness();

it("reports oversized dirty files and a 200-file untracked directory as unmeasured", async () => {
  const root = project();
  write(root, { "large.txt": "x".repeat(10 * 1024 * 1024 + 1),
    ...Object.fromEntries(Array.from({ length: 200 }, (_, k) => [`many/${k}.txt`, "x"])) });
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt).toMatchObject({ inherited: [], changed: [] });
  expect(receipt.unmeasured).toHaveLength(201);
  expect(receipt.unmeasured).toContainEqual({ path: "large.txt", reason: expect.stringContaining("10 MiB") });
  expect(receipt.unmeasured).toContainEqual({ path: "many/0.txt", reason: expect.stringContaining("200") });
});

it("writes no objects, refs or index bytes while fingerprinting", async () => {
  const root = project();
  write(root, { "notes.md": "old dirt\n", "untracked.txt": "old\n" });
  const state = () => ({ objects: spawnSync("git", ["count-objects", "-v"], { cwd: root, encoding: "utf8" }).stdout,
    refs: spawnSync("git", ["for-each-ref"], { cwd: root, encoding: "utf8" }).stdout,
    index: readFileSync(join(root, ".git/index")) });
  const before = state();
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  write(root, { "notes.md": "during request\n" });
  expect(entry(await run.settle()).customType).toBe("tesota-receipt");
  expect(state()).toEqual(before);
});

it("fingerprints and attributes repositories independently in a workspace", async () => {
  const root = folder();
  const a = project(join(root, "a"));
  const b = project(join(root, "b"));
  write(a, { "notes.md": "old a\n" });
  write(b, { "notes.md": "old b\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(b, { "new.txt": "during request\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.units).toHaveLength(1);
  expect(receipt.units?.[0]).toMatchObject({ folder: "b", inherited: ["notes.md"],
    changed: [{ path: "new.txt", blob: expect.any(String) }] });
});

it("reports a failed start capture and still verifies against H", async () => {
  const root = project();
  write(root, { "notes.md": "old dirt\n" });
  const run = gate(root);
  await run.input();
  const index = readFileSync(join(root, ".git/index"));
  writeFileSync(join(root, ".git/index"), "broken index");
  await run.tool("write");
  writeFileSync(join(root, ".git/index"), index);
  write(root, { "new.txt": "during request\n" });
  const settled = entry(await run.settle());
  expect(settled.details).toMatchObject({ startState: { status: "unknown", reason: expect.stringContaining("Git") },
    inherited: [], changed: [{ path: "new.txt", blob: expect.any(String) }, { path: "notes.md", blob: expect.any(String) }] });
  expect(settled.content).toContain("Unknown start state");
});

it("discloses a failed settlement capture when Git can no longer read the index", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  writeFileSync(join(root, ".git/index"), "broken index");
  const settled = entry(await run.settle());
  expect(settled.details).toMatchObject({ startState: { status: "known" }, endState: { status: "unknown", reason: expect.stringContaining("Git") }, changed: "unreadable", specificationEvidence: { weakened: "unreadable" } });
  expect(settled.content).toContain("Unknown end state");
});

it("keeps index conflicts eligible and explains the unknown start state", async () => {
  const root = project();
  git(root, "branch", "other");
  write(root, { "notes.md": "one\n" });
  commit(root, "one");
  git(root, "switch", "other");
  write(root, { "notes.md": "two\n" });
  commit(root, "two");
  expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-"], { cwd: root }).status).toBe(1);
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt).toMatchObject({ startState: { status: "unknown", reason: "the index has unresolved conflicts" },
    inherited: [], changed: [{ path: "notes.md", blob: expect.any(String) }] });
});

it("measures exactly 10 MiB and 199 untracked files, and keeps paths relative inside a repository", async () => {
  const root = project();
  write(root, { "src/large.txt": "x".repeat(10 * 1024 * 1024),
    ...Object.fromEntries(Array.from({ length: 199 }, (_, k) => [`src/many/${k}.txt`, "x"])) });
  const run = gate(join(root, "src"));
  await run.input();
  await run.tool("bash");
  expect(await run.settle()).toBeUndefined();
  write(root, { "src/new space ñ.txt": "during request\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "new space ñ.txt", blob: expect.any(String) }]);
  expect(receipt.unmeasured).toEqual([]);
  expect(receipt.inherited).toHaveLength(200);
  expect(receipt.inherited).toContain("large.txt");
});

it("counts the 200-file limit within untracked directories, excluding tracked ancestors", async () => {
  const root = project();
  write(root, { "src/one.txt": "x", "src/two.txt": "x",
    ...Object.fromEntries(Array.from({ length: 199 }, (_, k) => [`src/many/${k}.txt`, "x"])) });
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  expect(await run.settle()).toBeUndefined();
});

it("attributes both sides of a rename and retains an unchanged deletion as inherited", async () => {
  const root = project();
  rmSync(join(root, "src/rule.ts"));
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  git(root, "mv", "notes.md", "renamed space.md");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: null }, { path: "renamed space.md", blob: expect.any(String) }]);
  expect(receipt.inherited).toEqual(["src/rule.ts"]);
});

it("lists changed and untracked files, relative to the project, and nothing outside Git", async () => {
  const root = project();
  const base = await headCommit(root);
  expect(await changedFiles(root, base)).toEqual([]);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "src", "new.ts"), "export const a = 1;\n");
  rmSync(join(root, "notes.md"));
  expect(await changedFiles(root, base)).toEqual(["src/new.ts", "src/rule.ts"]);
  expect(await changedFiles(join(root, "src"), base)).toEqual(["new.ts", "rule.ts"]);
  const outside = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(outside);
  expect(await headCommit(outside)).toBeNull();
  expect(await changedFiles(outside, null)).toBeUndefined();
});

it("verifies a folder in no repository against Tesota's snapshot of it, whatever changed its files, and leaves it as it was", async () => {
  const root = plainProject();
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  expect(facts(entry(settled).content)).toBe([
    "  passed        bun run test",
    "  notices change test/negative.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; added in this request",
    "  not proved    src/price.mjs: no proof covers it; the project's commands pass with it",
    "  changed lines implementation +1 -1 · tests +4 -0"].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect([receipt.repository, receipt.snapshot]).toEqual([false, true]);
  expect(receipt.base).toMatch(/^[0-9a-f]{40}$/u);
  expect(existsSync(join(root, ".git"))).toBe(false);
  // The next request's snapshot holds these changes, so a run that changes nothing settles with no receipt.
  await run.input();
  expect(await run.settle()).toBeUndefined();
}, 60_000);

it("flags a test weakened in a folder in no repository", async () => {
  const root = plainProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/price.test.mjs": priceTest(1, 1) });
  expect(facts(entry(await run.settle()).content)).toContain("  may weaken    test/price.test.mjs: edits a test file");
}, 60_000);

it("says why a folder Tesota does not snapshot was not verified, once a tool may have changed files", async () => {
  const home = homedir();
  const run = gate(home);
  await run.input();
  await run.tool("read");
  expect(await run.settle()).toBeUndefined();
  await run.tool("edit");
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe("  not verified  this request's changes: Tesota does not snapshot a home folder " +
    "or a drive's root");
  expect((settled.details as Receipt).repository).toBe(false);
});

it("lists every file in a repository whose first commit the agent made", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  git(root, "init", "-q");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  commit(root, "agent");
  expect((entry(await run.settle()).details as Receipt).codeEvidence.unverified).toEqual(["notes.md"]);
});

it("runs only the commands of the projects that own the changed files, there and on the base", async () => {
  const passing = "import { test } from \"node:test\";\ntest(\"ok\", () => {});\n";
  const root = repository({
    "a/package.json": JSON.stringify({ scripts: { test: "node --test" } }), "a/bun.lock": "", "a/test/x.test.mjs": passing,
    "b/package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }), "b/bun.lock": "",
  });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "a/test/y.test.mjs": passing });
  expect(facts(entry(await run.settle()).content)).toBe(["  passed        cd a && bun run test",
    "  passes on base a/test/y.test.mjs: it passes without the change too; " +
    "by the whole check, `cd a && bun run test`; added in this request",
    "  changed lines tests +2 -0"].join("\n"));
}, 60_000);

it("verifies each repository the request changed in a folder of repositories, from its own base with its own commands", async () => {
  const root = workspace();
  const rulesBase = await headCommit(join(root, "rules"));
  // A branch that exists at admission, with a commit of its own, that the request merges in.
  const published = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "published"],
    { cwd: join(root, "rules"), encoding: "utf8" }).stdout.trim();
  git(join(root, "rules"), "branch", "published", published);
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(join(root, "api"), { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n" });
  writeFileSync(join(root, "rules", "src", "rule.ts"), `${contract}// changed\n`);
  commit(join(root, "rules"), "the agent's commit");
  // That branch reaches the merged history: only this unit loses credit.
  git(join(root, "rules"), "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "published");
  write(root, { "notes/todo.md": "- one\n- two\n" });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  // The folders in no repository are measured against Tesota's snapshot: the one changed is listed, the workspace's own files are not.
  expect(facts(entry(settled).content)).toBe([
    "  passed        cd api && bun run test",
    "  not proved    api/src/price.mjs: no proof covers it; the project's commands pass with it",
    "  not verified  notes/todo.md: no verifier covers it",
    "  proved        rules/src/rule.ts",
    "                Proved in LemmaScript's model: numbers are exact integers or reals, not floating-point, so rounding, NaN and Infinity aren't covered; nor are await and other unsupported features",
    "                content sha256 e8cda4ec2c6b993b18bb0e32a0a802c2a8f8c0cd3ffce5cb3023500d04d3e639",
    "  changed lines implementation +2 -1 · other +1 -0"].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect(receipt.units?.map(({ folder: at, repository, snapshot }) => [at, repository, snapshot ?? false]))
    .toEqual([["api", true, false], ["notes", false, true], ["rules", true, false]]);
  expect(receipt.units?.[2]?.base).toBe(rulesBase);
  expect(receiptFindings(receipt).filter(({ label }) => label === "Attribution unresolved").map(({ subject }) => subject))
    .toEqual(["rules"]);
  expect(receiptSummary(receipt).limits.some(({ note }) => note.startsWith("rules: history moved"))).toBe(true);
  // Each repository's evidence stays in its own terms, as a pull request in it reads them.
  expect(receipt.units?.[2]?.codeEvidence.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
  expect(receipt.units?.[0]?.codeEvidence.tests.map(({ command }) => command)).toEqual(["bun run test"]);
  expect(existsSync(join(root, "notes", ".git"))).toBe(false);
}, 60_000);

it("sends a repository's failure back by its path in the folder, and runs nothing in a repository the request left alone", async () => {
  const root = folder();
  project(join(root, "a"));
  testedProject("node -e process.exit(1)", join(root, "b"));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "a", "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const back = entry(await run.settle());
  expect(back.content).toContain("Tesota: a/src/rule.ts does not prove yet.");
  expect((back.details as SentBack).round).toBe("proofs");
  scripted.delete("src/rule.ts");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.units?.map(({ folder: at }) => at)).toEqual(["a"]);
  expect(receipt.base).toBeNull();
});

it("keeps one repository's repeated failure from stopping another's from going back", async () => {
  const root = folder();
  project(join(root, "a"));
  project(join(root, "b"));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "a", "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect(entry(await run.settle()).content).toContain("Tesota: a/src/rule.ts does not prove yet.");
  writeFileSync(join(root, "b", "src", "rule.ts"), `${contract}// changed\n`);
  const back = entry(await run.settle());
  expect(back.content).not.toContain("a/src/rule.ts");
  expect(back.content).toContain("Tesota: b/src/rule.ts does not prove yet.");
});
it("settles a stop whose inventory Git never answers, saying the inventory ran past its time limit", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "# Changed\n" });
  const module = await import("../src/git.js");
  const never = (): Promise<never> => new Promise(() => undefined);
  const gitCalls = vi.spyOn(module, "git").mockImplementation(never);
  const outputCalls = vi.spyOn(module, "gitOutput").mockImplementation(never);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled: Settled | undefined;
    let done = false;
    void run.settle("aborted").then((result) => { settled = result; done = true; });
    // The clock moves past the limit once the inventory waits on Git; real time moves only for what the gate loads.
    for (const begun = performance.now(); !done && performance.now() - begun < 20_000;) {
      await vi.advanceTimersByTimeAsync(STOP_INVENTORY_TIME_LIMIT_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(gitCalls.mock.calls.length + outputCalls.mock.calls.length).toBeGreaterThan(0);
    const receipt = entry(settled).details as Receipt;
    expect(receipt).toMatchObject({ stopped: "the operator stopped the run before Tesota verified it", changed: "unreadable", lines: "unreadable", reason: "the inventory ran past its time limit", codeEvidence: { proofs: [], tests: [] } });
    expect(receiptStanding(receipt)).toBe("incomplete");
  } finally { vi.useRealTimers(); gitCalls.mockRestore(); outputCalls.mockRestore(); }
});

it("stops the Git a stopped run's inventory abandons at its limit, with every process Git started", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  const { pids, release } = hangingFilter(root, "* filter=hang\n");
  write(root, { "notes.md": "# Changed\n" });
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let started: number[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled: Settled | undefined;
    let done = false;
    void run.settle("aborted").then((result) => { settled = result; done = true; });
    // The clock moves past the limit only once Git hangs in the filter.
    for (const begun = performance.now(); !existsSync(pids) && performance.now() - begun < 20_000;) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const begun = performance.now(); started.length === 0 && performance.now() - begun < 5_000;) {
      try { started = JSON.parse(readFileSync(pids, "utf8")) as number[]; } catch { await new Promise((resolve) => setImmediate(resolve)); }
    }
    expect(started).toHaveLength(3);
    // One limit passes; the stop then settles in real time, once Git's processes are stopped.
    await vi.advanceTimersByTimeAsync(STOP_INVENTORY_TIME_LIMIT_MS);
    for (const begun = performance.now(); !done && performance.now() - begun < 20_000;) await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(true);
    expect(entry(settled).details).toMatchObject({ changed: "unreadable", lines: "unreadable",
      reason: "the inventory ran past its time limit" });
    vi.useRealTimers();
    // On Windows the stop settles only after the tree is gone; elsewhere the group's kill is delivered at once.
    for (const end = Date.now() + 2_000; started.some(alive) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started.filter(alive)).toEqual([]);
  } finally {
    vi.useRealTimers();
    release();
    for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 60_000);
