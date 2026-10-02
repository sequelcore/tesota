import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { Workspace } from "../src/workspace.js";
import { applyWorkspace, ApplyConflictError } from "../src/workspace-apply.js";
import { type ApprovedCheck, runChecks, suggestChecks } from "../src/workspace-checks.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false",
    "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Test Git failed");
  return result.stdout;
}

async function fixture(): Promise<{ source: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-workspace-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  git(source, ["init", "--quiet"]);
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\n");
  await writeFile(join(source, "src/old.ts"), "export const old = true;\n");
  await writeFile(join(source, ".gitignore"), "node_modules/\nreports/\n");
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { source, workspace: await Workspace.create(source, join(root, "workspaces"), { sourcesRoot: join(dirname(join(root, "workspaces")), "sources") }) };
}

function plain(...commands: string[]): ApprovedCheck[] {
  return commands.map((command) => ({ command, reports: [] }));
}

async function changeEverything(workspace: Workspace): Promise<void> {
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  await writeFile(join(workspace.checkout, "src/tax.ts"), "export const tax = 0.2;\n");
  await unlink(join(workspace.checkout, "src/old.ts"));
}

it("describes added, modified and deleted files with a complete diff", async () => {
  const { workspace } = await fixture();
  expect(workspace.snapshot().changes).toEqual([]);
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  expect(snapshot.changes).toEqual([
    { status: "deleted", path: "src/old.ts" },
    { status: "modified", path: "src/price.ts" },
    { status: "added", path: "src/tax.ts" },
  ]);
  expect(snapshot.diff).toContain("+export const tax = 0.2;");
  expect(snapshot.diff).toContain("-export const old = true;");
});

it("reverts work but keeps ignored files such as installed dependencies", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  await mkdir(join(workspace.checkout, "node_modules"));
  await writeFile(join(workspace.checkout, "node_modules/dep.js"), "installed\n");
  workspace.revert();
  expect(workspace.snapshot().changes).toEqual([]);
  expect(existsSync(join(workspace.checkout, "src/tax.ts"))).toBe(false);
  expect(await readFile(join(workspace.checkout, "node_modules/dep.js"), "utf8")).toBe("installed\n");
});

it("applies the reviewed content to the source and makes it the new base", async () => {
  const { source, workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  await expect(applyWorkspace(workspace, snapshot)).resolves.toEqual({ changes: snapshot.changes, alsoChanged: [] });
  expect(await readFile(join(source, "src/price.ts"), "utf8")).toBe("export const price = 2;\n");
  expect(await readFile(join(source, "src/tax.ts"), "utf8")).toBe("export const tax = 0.2;\n");
  expect(existsSync(join(source, "src/old.ts"))).toBe(false);
  expect(workspace.base).not.toBe(snapshot.base);
  expect(workspace.snapshot().changes).toEqual([]);
  expect(git(source, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
});

it("refuses to overwrite files that changed in the source and writes nothing", async () => {
  const { source, workspace } = await fixture();
  await changeEverything(workspace);
  await writeFile(join(source, "src/price.ts"), "export const price = 3;\n");
  const snapshot = workspace.snapshot();
  const failure = applyWorkspace(workspace, snapshot);
  await expect(failure).rejects.toBeInstanceOf(ApplyConflictError);
  await expect(failure).rejects.toMatchObject({ paths: ["src/price.ts"] });
  expect(existsSync(join(source, "src/tax.ts"))).toBe(false);
  expect(existsSync(join(source, "src/old.ts"))).toBe(true);
  expect(workspace.base).toBe(snapshot.base);
});

it("treats a CRLF checkout of the base content as unchanged and keeps its line endings", async () => {
  const { source, workspace } = await fixture();
  git(source, ["config", "core.autocrlf", "true"]);
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\r\n");
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  await applyWorkspace(workspace, workspace.snapshot());
  expect(await readFile(join(source, "src/price.ts"), "utf8")).toBe("export const price = 2;\r\n");
});

it("builds on uncommitted work and applies only the agent's changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-workspace-dirty-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  git(source, ["init", "--quiet"]);
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\n");
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  await writeFile(join(source, "src/price.ts"), "export const price = 5;\n");
  await writeFile(join(source, "notes.md"), "operator notes\n");
  const workspace = await Workspace.create(source, join(root, "workspaces"), { sourcesRoot: join(dirname(join(root, "workspaces")), "sources") });
  expect(workspace.included).toEqual([{ status: "added", path: "notes.md" }, { status: "modified", path: "src/price.ts" }]);
  expect(workspace.snapshot().changes).toEqual([]);
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 6;\n");
  const snapshot = workspace.snapshot();
  expect(snapshot.changes).toEqual([{ status: "modified", path: "src/price.ts" }]);
  await applyWorkspace(workspace, snapshot);
  expect(await readFile(join(source, "src/price.ts"), "utf8")).toBe("export const price = 6;\n");
  expect(await readFile(join(source, "notes.md"), "utf8")).toBe("operator notes\n");
});

it("refuses to change a symbolic link and writes nothing", async () => {
  const { source, workspace: initial } = await fixture();
  if (process.platform === "win32") {
    // Git for Windows keeps a link as a file holding its target, so the fixture records one that way.
    await writeFile(join(source, "link"), "src/price.ts");
    const blob = git(source, ["hash-object", "-w", "link"]).trim();
    git(source, ["update-index", "--add", "--cacheinfo", `120000,${blob},link`]);
  } else {
    await symlink("src/price.ts", join(source, "link"));
    git(source, ["add", "link"]);
  }
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Link"]);
  const workspace = await Workspace.create(source, join(initial.directory, "..", "more"), { sourcesRoot: join(dirname(join(initial.directory, "..", "more")), "sources") });
  await writeFile(join(workspace.checkout, "link"), "../../elsewhere");
  await writeFile(join(workspace.checkout, "src/tax.ts"), "export const tax = 0.2;\n");
  const failure = applyWorkspace(workspace, workspace.snapshot());
  await expect(failure).rejects.toThrow("Symbolic links and submodules cannot be changed");
  expect(existsSync(join(source, "src/tax.ts"))).toBe(false);
});

it("refuses content that changed after review", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 9;\n");
  await expect(applyWorkspace(workspace, snapshot)).rejects.toThrow("changed after review");
});

it("binds check outcomes to the reviewed tree", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  const signal = new AbortController().signal;
  const environment = await hostProvider.prepare(workspace.checkout);
  const results = await runChecks(environment, workspace, snapshot, plain("node -e \"process.exit(0)\"", "node -e \"process.exit(3)\""), signal);
  expect(results.map((result) => [result.outcome, result.exitCode, result.tree, result.environment])).toEqual([
    ["passed", 0, snapshot.tree, "host"], ["failed", 3, snapshot.tree, "host"],
  ]);
  const changing = await runChecks(environment, workspace, snapshot,
    plain("node -e \"require('fs').writeFileSync('src/price.ts', 'formatted')\"", "node -e \"process.exit(0)\""), signal);
  expect(changing.map((result) => result.outcome)).toEqual(["changed_files"]);
});

it("runs a failing check again on the base, and sends back only a failure the candidate brought", async () => {
  const { workspace } = await fixture();
  await mkdir(join(workspace.checkout, "node_modules"));
  await writeFile(join(workspace.checkout, "node_modules/dep.js"), "installed\n");
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  const environment = await hostProvider.prepare(workspace.checkout);
  const commands: string[] = [];
  const counted = { ...environment, run: (command: string, options: Parameters<typeof environment.run>[1]) => {
    commands.push(command);
    return environment.run(command, options);
  } };
  // Passes only on the base: the base's files, and the ignored dependencies, in place of the candidate's.
  const onBase = "node -e \"const fs = require('fs'); process.exit(fs.existsSync('src/old.ts') && !fs.existsSync('src/tax.ts') && " +
    "fs.readFileSync('src/price.ts', 'utf8').includes('= 1;') && fs.existsSync('node_modules/dep.js') ? 0 : 1)\"";
  const broken = "node -e \"process.exit(4)\"";
  const baseRuns = new Map();
  const results = await runChecks(counted, workspace, snapshot, plain(onBase, broken, "node -e \"process.exit(0)\""),
    new AbortController().signal, { baseRuns });
  expect(results.map((result) => [result.outcome, result.base])).toEqual([
    ["failed", { outcome: "passed", exitCode: 0, origin: "introduced" }],
    ["failed", { outcome: "failed", exitCode: 4, origin: "preexisting" }],
    ["passed", undefined],
  ]);
  expect(workspace.snapshot().tree).toBe(snapshot.tree);
  expect(await readFile(join(workspace.checkout, "src/tax.ts"), "utf8")).toBe("export const tax = 0.2;\n");
  expect(existsSync(join(workspace.checkout, "src/old.ts"))).toBe(false);
  expect(existsSync(join(workspace.checkout, "node_modules/dep.js"))).toBe(true);
  // A correction round on the same base does not pay for the base again.
  commands.length = 0;
  expect(results.map((result) => typeof result.baseDurationMs)).toEqual(["number", "number", "undefined"]);
  const again = await runChecks(counted, workspace, snapshot, plain(onBase, broken), new AbortController().signal, { baseRuns });
  expect(commands).toEqual([onBase, broken]);
  expect(again.map((result) => result.baseDurationMs)).toEqual([undefined, undefined]);
});

it("runs a related form for the changed files and judges its failure by the whole command on the base", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  const environment = await hostProvider.prepare(workspace.checkout);
  const commands: string[] = [];
  const counted = { ...environment, run: (command: string, options: Parameters<typeof environment.run>[1]) => {
    commands.push(command);
    return environment.run(command, options);
  } };
  // The related form fails on the candidate; the whole command passes on the base, so the failure comes with the changes.
  const check: ApprovedCheck = { command: "node -e \"process.exit(0)\"", reports: [],
    related: { command: "node -e \"process.exit(3)\" {files}", reports: [] } };
  const files = snapshot.changes.filter((item) => item.status !== "deleted").map((item) => item.path);
  const [result] = await runChecks(counted, workspace, snapshot, [check], new AbortController().signal, { relatedFiles: files });
  expect(commands).toEqual([`node -e "process.exit(3)" ${files.map((path) => `'${path}'`).join(" ")}`, check.command]);
  expect(result).toMatchObject({ outcome: "failed", relatedTo: check.command,
    claim: `The tests \`${check.command}\` relates to the ${files.length} changed files pass on this tree`,
    base: { outcome: "passed", origin: "introduced" } });
  // Without changed files to select by, the whole command runs and makes the usual claim.
  const [whole] = await runChecks(environment, workspace, snapshot, [check], new AbortController().signal);
  expect(whole).toMatchObject({ outcome: "passed", command: check.command });
  expect(whole?.relatedTo).toBeUndefined();
});

it("leaves the cause unknown when the base run changes files, and removes what it added", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  const environment = await hostProvider.prepare(workspace.checkout);
  const writes = "node -e \"const fs = require('fs'); if (fs.existsSync('src/old.ts')) fs.writeFileSync('stray.txt', 'x'); process.exit(1)\"";
  const [result] = await runChecks(environment, workspace, snapshot, plain(writes), new AbortController().signal);
  expect(result?.base).toEqual({ outcome: "changed_files", exitCode: 1, origin: "unknown" });
  expect(existsSync(join(workspace.checkout, "stray.txt"))).toBe(false);
  expect(workspace.snapshot().tree).toBe(snapshot.tree);
});

/**
 * A test command that fails and writes JUnit reports under the ignored
 * `reports/`, telling the candidate from the base by `src/tax.ts`: `loopback`
 * fails on both, as servers a sandbox refuses do; in `tests` mode `price`
 * fails only on the candidate and `tax` exists only there.
 */
const reporter = `const fs = require("fs");
const mode = process.argv[2];
const candidate = fs.existsSync("src/tax.ts");
const failure = '<failure message="x &amp; y"><![CDATA[expected a < b]]></failure>';
const xml = (cases) => '<?xml version="1.0"?><testsuites><testsuite name="suite">' + cases.map(([name, failed]) =>
  '<testcase classname="suite" name="' + name + '">' + (failed ? failure : "") + "</testcase>").join("") + "</testsuite></testsuites>";
fs.mkdirSync("reports", { recursive: true });
if (mode === "tests") {
  fs.writeFileSync("reports/a.xml", xml([["loopback", true]]));
  fs.writeFileSync("reports/b.xml", xml(candidate ? [["price", true], ["tax", true]] : [["price", false]]));
}
if (mode === "same") fs.writeFileSync("reports/a.xml", xml([["loopback", true]]));
if (mode === "partial") {
  fs.writeFileSync("reports/a.xml", xml([["loopback", true]]));
  if (candidate) fs.writeFileSync("reports/b.xml", xml([["tax", true]]));
}
if (mode === "partial-new") {
  fs.writeFileSync("reports/a.xml", xml(candidate ? [["loopback", true], ["tax", true]] : [["loopback", true]]));
  if (candidate) fs.writeFileSync("reports/b.xml", xml([["price", true]]));
}
if (mode === "base-only" && !candidate) fs.writeFileSync("reports/a.xml", xml([["loopback", true]]));
process.exit(1);
`;

async function reportedFixture(): Promise<{ workspace: Workspace; snapshot: ReturnType<Workspace["snapshot"]>;
  environment: Awaited<ReturnType<typeof hostProvider.prepare>>; run: (mode: string) => ApprovedCheck; commands: string[] }> {
  const { workspace } = await fixture();
  await mkdir(join(workspace.checkout, "node_modules"));
  await writeFile(join(workspace.checkout, "node_modules/reporter.js"), reporter);
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  const prepared = await hostProvider.prepare(workspace.checkout);
  const commands: string[] = [];
  const environment = { ...prepared, run: (command: string, options: Parameters<typeof prepared.run>[1]) => {
    commands.push(command);
    return prepared.run(command, options);
  } };
  const run = (mode: string): ApprovedCheck => ({ command: `node node_modules/reporter.js ${mode}`,
    reports: ["reports/a.xml", "reports/b.xml"] });
  return { workspace, snapshot, environment, run, commands };
}

it("sends back a check that fails without the changes too when a test fails only with them", async () => {
  const { workspace, snapshot, environment, run, commands } = await reportedFixture();
  const baseRuns = new Map();
  const [result] = await runChecks(environment, workspace, snapshot, [run("tests")], new AbortController().signal, { baseRuns });
  // `price` passes on the base and `tax` has no result there; `loopback` fails on both.
  expect(result?.base).toEqual({ outcome: "failed", exitCode: 1, origin: "introduced",
    introducedTests: ["suite > price", "suite > tax"] });
  // The base's reports are not left for the agent to read as its own.
  expect(existsSync(join(workspace.checkout, "reports/a.xml"))).toBe(false);
  expect(workspace.snapshot().tree).toBe(snapshot.tree);
  // A correction round on the same base keeps the base's tests without running it again.
  commands.length = 0;
  const [again] = await runChecks(environment, workspace, snapshot, [run("tests")], new AbortController().signal, { baseRuns });
  expect(commands).toEqual([run("tests").command]);
  expect(again?.base).toEqual(result?.base);
});

it.each([
  ["same", "the same tests fail without the changes"],
  ["partial", "a report the base run did not write leaves its tests unread, not absent"],
])("keeps a failure as already there in %s mode: %s", async (mode) => {
  const { workspace, snapshot, environment, run } = await reportedFixture();
  const [result] = await runChecks(environment, workspace, snapshot, [run(mode)], new AbortController().signal);
  expect(result?.base).toEqual({ outcome: "failed", exitCode: 1, origin: "preexisting" });
});

it("sends back a new failing test from a report the base wrote, though the base did not write every report", async () => {
  const { workspace, snapshot, environment, run } = await reportedFixture();
  const [result] = await runChecks(environment, workspace, snapshot, [run("partial-new")], new AbortController().signal);
  // `tax` is in a report the base wrote without it; `price` is in one the base did not write, so it stays unread.
  expect(result?.base).toEqual({ outcome: "failed", exitCode: 1, origin: "introduced", introducedTests: ["suite > tax"] });
});

it("does not run a check whose report cannot be removed first, and goes on with the others", async () => {
  const { workspace, snapshot, environment, run, commands } = await reportedFixture();
  await mkdir(join(workspace.checkout, "reports/a.xml"), { recursive: true });
  await writeFile(join(workspace.checkout, "reports/a.xml/stale.txt"), "x");
  const results = await runChecks(environment, workspace, snapshot, [run("tests"), ...plain("node -e \"process.exit(0)\"")],
    new AbortController().signal);
  expect(results.map((result) => result.outcome)).toEqual(["not_started", "passed"]);
  expect(results[0]?.output).toContain("reports/a.xml could not be removed");
  expect(commands).toEqual(["node -e \"process.exit(0)\""]);
});

it("leaves the cause unknown when a report cannot be removed before the base run, and still reports every check", async () => {
  const { workspace, snapshot, environment } = await reportedFixture();
  // The candidate's run leaves a directory where its report should be, which outlasts the switch to the base.
  const blocking = { command: "node -e \"require('fs').mkdirSync('reports/a.xml', { recursive: true }); process.exit(1)\"",
    reports: ["reports/a.xml"] };
  const results = await runChecks(environment, workspace, snapshot, [blocking, ...plain("node -e \"process.exit(0)\"")],
    new AbortController().signal);
  expect(results.map((result) => [result.outcome, result.base])).toEqual([
    ["failed", { outcome: "not_started", exitCode: null, origin: "unknown" }],
    ["passed", undefined],
  ]);
  expect(workspace.snapshot().tree).toBe(snapshot.tree);
});

it("reads only the reports a run wrote, never an earlier run's", async () => {
  const { workspace, snapshot, environment, run } = await reportedFixture();
  // An earlier run's report, in the ignored directory, that this candidate run does not replace.
  await mkdir(join(workspace.checkout, "reports"));
  await writeFile(join(workspace.checkout, "reports/a.xml"),
    '<testsuites><testsuite name="suite"><testcase classname="suite" name="ghost"><error/></testcase></testsuite></testsuites>');
  const [result] = await runChecks(environment, workspace, snapshot, [{ ...run("base-only"), reports: ["reports/a.xml"] }],
    new AbortController().signal);
  expect(result?.base).toEqual({ outcome: "failed", exitCode: 1, origin: "preexisting" });
});

it("does not run a check whose report Git would record as a change", async () => {
  const { workspace, snapshot, environment, commands } = await reportedFixture();
  const [result, next] = await runChecks(environment, workspace, snapshot,
    [{ command: "node -e \"process.exit(0)\"", reports: ["out/unit.xml"] }, ...plain("node -e \"process.exit(0)\"")],
    new AbortController().signal);
  expect(result).toMatchObject({ outcome: "not_started", exitCode: null });
  expect(result?.output).toContain("out/unit.xml");
  expect(next?.outcome).toBe("passed");
  expect(commands).toEqual(["node -e \"process.exit(0)\""]);
});

it("restores a candidate that a stopped run on the base left pinned", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  // What Tesota leaves if it stops while the checkout holds the base.
  git(workspace.checkout, ["update-ref", "refs/tesota/candidate", snapshot.tree]);
  git(workspace.checkout, ["read-tree", "--reset", "-u", "HEAD"]);
  expect(existsSync(join(workspace.checkout, "src/tax.ts"))).toBe(false);
  const reopened = await Workspace.open(workspace.directory);
  expect(reopened.snapshot().tree).toBe(snapshot.tree);
  expect(() => git(reopened.checkout, ["rev-parse", "--verify", "--quiet", "refs/tesota/candidate"])).toThrow();
});

it("suggests the repository's own check script", async () => {
  const { workspace } = await fixture();
  expect(suggestChecks(workspace.checkout)).toEqual([]);
  await writeFile(join(workspace.checkout, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "oxlint" } }));
  expect(suggestChecks(workspace.checkout)).toEqual(["npm run lint", "npm run test"]);
  await writeFile(join(workspace.checkout, "bun.lock"), "");
  await writeFile(join(workspace.checkout, "package.json"), JSON.stringify({ scripts: { check: "all", test: "vitest" } }));
  expect(suggestChecks(workspace.checkout)).toEqual(["bun run check"]);
});

it("keeps the requests behind the pending changes outside the checkout, starting over when nothing is pending", async () => {
  const { workspace } = await fixture();
  await workspace.recordRequest("Explain pricing");
  await workspace.recordRequest("Double the price");
  expect(await workspace.requests()).toEqual(["Double the price"]);
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  await workspace.recordRequest("Also add a tax");
  expect(await workspace.requests()).toEqual(["Double the price", "Also add a tax"]);
  expect(git(workspace.checkout, ["status", "--porcelain", "--ignored"])).not.toContain("request");
  expect(await (await Workspace.open(workspace.directory)).requests()).toEqual(["Double the price", "Also add a tax"]);
  workspace.revert();
  await workspace.recordRequest("Start over");
  expect(await workspace.requests()).toEqual(["Start over"]);
});

it("reads a file as the base or a candidate tree holds it", async () => {
  const { workspace } = await fixture();
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  const snapshot = workspace.snapshot();
  expect(workspace.contentAt(snapshot.base, "src/price.ts")).toBe("export const price = 1;\n");
  expect(workspace.contentAt(snapshot.tree, "src/price.ts")).toBe("export const price = 2;\n");
  expect(workspace.contentAt(snapshot.base, "src/missing.ts")).toBeUndefined();
});

it("compares one candidate with its correction", async () => {
  const { workspace } = await fixture();
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  const first = workspace.snapshot();
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 3;\n");
  await writeFile(join(workspace.checkout, "src/tax.ts"), "export const tax = 1;\n");
  const second = workspace.snapshot();
  const correction = workspace.compare(first.tree, second.tree);
  expect(correction.changes).toEqual([{ status: "modified", path: "src/price.ts" }, { status: "added", path: "src/tax.ts" }]);
  expect(correction.diff).toContain("-export const price = 2;\n+export const price = 3;");
  expect(correction.diff).not.toContain("price = 1");
});

it("keeps a request pending across a turn that changed nothing while its answer check left gaps", async () => {
  const { workspace } = await fixture();
  await workspace.recordRequest("Add a farewell() helper");
  workspace.keepRequestsOpen(true);
  await workspace.recordRequest("Continue");
  expect(await workspace.requests()).toEqual(["Add a farewell() helper", "Continue"]);
  workspace.keepRequestsOpen(false);
  await workspace.recordRequest("Explain pricing");
  expect(await workspace.requests()).toEqual(["Explain pricing"]);
});

it("states in a check's result which hidden files the operator let it read", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const environment = await hostProvider.prepare(workspace.checkout);
  const [result] = await runChecks(environment, workspace, workspace.snapshot(), plain("node -e \"process.exit(0)\""),
    new AbortController().signal, { readsHidden: [".env"] });
  expect(result?.limits).toBe("Establishes only what the command itself tests. It could read hidden files the operator allowed: .env.");
});
