import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runProcess } from "../src/process.js";
import type { Finding } from "./finding-cases.js";
import { JEV_SKIP_BELOW, diffFiles, git, jevSkips, jevTriage, option, parseFindings, pi, pool, results, reviewPrompt, ruleSkips, where }
  from "./review-session.js";

/**
 * Findings as evidence (#375) on SWE-smith's JavaScript bugs
 * (`SWE-bench/SWE-smith-js`), registered on 2026-10-10 before any review:
 * bugs planted in real repositories, each with the tests it breaks and a
 * Docker image of the repository before the bug, which is the correct
 * reference. Each sampled instance gives two changes to review:
 *
 * - `bug`: the planted bug as the change, for the request to refactor its
 *   files without changing behavior. Sol judges whether each finding names a
 *   behavior change the bug's diff really makes (`judge`).
 * - `control`: the exact fix of the bug as the change, from the buggy code,
 *   for the bug report as the request. It is correct, so every finding on it
 *   counts as false.
 *
 * The gate's agent writes a test whose names start with `tesota repro` and
 * runs it in the instance's container through `evaluation/swesmith/run.py`;
 * the harness then runs it on the change and on the reference. Sampling
 * takes one instance per repository, in the order of a SHA-256 of the seed
 * and its name, and keeps an instance only when every one of its failing
 * tests passes before the bug and fails with it, each run within ten
 * minutes and 4 GB of memory, the cap every container here runs under; it
 * tries three instances of a repository before skipping it. At most
 * `--parallel` findings, two by default, are gated at once, each running one
 * container at a time.
 *
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<instances.jsonl> --stage=sample [--count=20] [--seed=375]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=review --model=openai/gpt-6-sol
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=triage
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=judge [--model=openai/gpt-6-sol]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=gate [--model=openai/gpt-6-luna]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=rerun [--model=openai/gpt-6-luna]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=fix [--model=openai/gpt-6-luna] [--gate-model=<model>]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=cases [--model=openai/gpt-6-sol] [--source=<reviewer>] [--per-bug=1|all]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=checks [--model=claude-bridge/claude-sonnet-5-5] [--prompt=1|2]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=refute --source=<checks source> [--model=claude-bridge/claude-sonnet-5-5]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=score-arms [--refuter=<model>]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=code-review [--model=claude-sonnet-5-5] [--effort=high]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=ultrareview --instance=<id> --arm=bug|control
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=approve --source=<reviewer|checks:model> [--arm=bug|control] [--model=claude-bridge/claude-opus-5-5] [--prompt=1|2] [--limit=<n>]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=faithful [--source=<source>] [--arm=bug|control] [--model=claude-bridge/claude-sonnet-5-5]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=score-checks [--model=<approver>]
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=export-cases --file=<cases.json>
 *   bun run swesmith:eval --out=<file> --work=<dir> --data=<file> --stage=score [--model=<gate model>] [--table=<file>]
 *
 * `--work` holds the repositories and the runs, outside the repository; the
 * runner image is built first: `docker build -t tesota-swesmith:9b74ac0 evaluation/swesmith`.
 */
const { records, append } = results(option("out"));
const work = resolve(option("work") ?? "");
if (option("work") === undefined) throw new Error("Name a working folder with --work=<dir>, outside the repository.");
const parallel = Number(option("parallel") ?? "2");
const IMAGE = "tesota-swesmith:9b74ac0";
const MARK = "tesota repro";
const TEST_TIMEOUT_S = 600;
const forward = (path: string): string => path.replaceAll("\\", "/");

interface Instance {
  readonly instance_id: string;
  readonly patch: string;
  readonly FAIL_TO_PASS: readonly string[];
  readonly PASS_TO_PASS: readonly string[];
  readonly image_name: string;
  readonly repo: string;
  readonly problem_statement: string;
}

const instances = new Map((readFileSync(option("data") ?? "", "utf8")).split("\n").filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Instance).map((instance) => [instance.instance_id, instance]));

type Arm = "bug" | "control";
const ARMS: readonly Arm[] = ["bug", "control"];

const request = (instance: Instance, arm: Arm): string => arm === "bug"
  ? `Refactor ${[...instance.patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]).join(", ")} for readability, without ` +
    "changing behavior."
  : `Fix this bug report:\n\n${instance.problem_statement}`;

const judgePrompt = (instance: Instance, finding: Finding): string =>
  `A change was meant to keep behavior, but it introduced a bug with this diff:\n\n\`\`\`diff\n${instance.patch}\n\`\`\`\n\n` +
  `The bug's symptoms, as a user reported them:\n\n${instance.problem_statement}\n\nA reviewer reported this finding about the ` +
  `change:\n\n${where(finding)}: ${finding.statement}\nReason: ${finding.reason}\n\nDoes the finding identify a behavior change ` +
  "this diff really introduces, in the code the diff changes? Answer only with a JSON object in a ```json block: " +
  "{\"real\": true or false, \"why\": \"one sentence\"}.";

const gatePrompt = (requested: string, finding: Finding, script: string): string =>
  `A reviewer reported this finding about the uncommitted change in this repository (\`git diff\` shows it), made for this ` +
  `request:\n\n${requested}\n\nFinding: ${where(finding)}: ${finding.statement}\nReason: ${finding.reason}\n\n` +
  "Turn the finding into a reproduction test: add one new test file whose name contains `tesota-repro`, where the " +
  `repository's test command runs it, written like the repository's other tests, with every test's name starting with ` +
  `\`${MARK}\`. It must fail on the current code because of exactly this defect, and pass once the defect is fixed as the ` +
  `request asks. The tests run only in a container: \`bash ${script}\` runs the repository's tests with your file and ` +
  `shows the results of the \`${MARK}\` tests. Do not change any other file. If the finding is wrong, so that no such ` +
  "test fails on the current code, do not write the file, and say why.";

/** The instance's tests in its container with `patch` applied over the code before the bug, as `run.py` reports them. */
async function runTests(instance: Instance, patch: string): Promise<Record<string, any>> {
  mkdirSync(join(work, "runs"), { recursive: true });
  const directory = mkdtempSync(join(work, "runs", "run-"));
  writeFileSync(join(directory, "instance.json"), JSON.stringify(instance));
  writeFileSync(join(directory, "change.diff"), patch);
  const ended = await runProcess("docker", ["run", "--rm", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v",
    `${forward(directory)}:/work`, IMAGE, "python", "/opt/run.py", "--instance-file", "/work/instance.json", "--patch-file",
    "/work/change.diff", "--out-file", "/work/result.json", "--timeout", String(TEST_TIMEOUT_S)], directory,
    new AbortController().signal, 30 * 60_000);
  // No result means the runner itself failed, which says nothing about the instance.
  if (!existsSync(join(directory, "result.json"))) throw new Error(`run.py gave no result: ${ended.output.slice(-1500)}`);
  return JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) as Record<string, any>;
}

/** A fresh copy of the repository before the bug, its tracked files as the image holds them, committed as `clean`. */
function cleanCopy(instance: Instance): string {
  const archive = join(work, "archives", `${instance.image_name.replaceAll("/", "_")}.tar`);
  mkdirSync(join(work, "archives"), { recursive: true });
  if (!existsSync(archive)) {
    // The tracked files with symbolic links replaced by what they point to, which Windows cannot always create; a link to
    // nothing is skipped.
    const exported = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", instance.image_name, "-c",
      "cd /testbed && git ls-files -z | tar -c --dereference --ignore-failed-read --null -T -"], { maxBuffer: 2 * 1024 * 1024 * 1024 });
    if (exported.status !== 0) throw new Error(`export ${instance.image_name}: ${exported.stderr.toString()}`);
    writeFileSync(archive, exported.stdout);
  }
  mkdirSync(join(work, "projects"), { recursive: true });
  const directory = join(mkdtempSync(join(work, "projects", "p-")), "project");
  mkdirSync(directory);
  // Piped in: GNU tar reads a drive letter in a path as a remote host.
  const extracted = spawnSync("tar", ["-x"], { cwd: directory, input: readFileSync(archive), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (extracted.status !== 0) throw new Error(`tar: ${extracted.stderr}`);
  git(directory, "init", "-q");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "--no-verify", "-m", "clean");
  git(directory, "tag", "clean");
  return directory;
}

/** The change to review for an arm, uncommitted over its base: the bug over the clean code, or its fix over the bug. */
function changed(instance: Instance, arm: Arm): string {
  const directory = cleanCopy(instance);
  const patch = join(directory, "..", "bug.diff");
  writeFileSync(patch, instance.patch);
  if (arm === "control") {
    git(directory, "apply", patch);
    git(directory, "commit", "-q", "--no-verify", "-am", "base");
  }
  git(directory, "apply", ...arm === "control" ? ["-R"] : [], patch);
  git(directory, "add", "-N", ".");
  return directory;
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

function sampled(): Instance[] {
  return records().filter((record) => record["kind"] === "sample" && record["valid"] === true)
    .flatMap((record) => instances.get(String(record["instance"])) ?? []);
}

/** Why an instance cannot be used, if it cannot: each failing test must pass before the bug and fail with it. */
async function validate(instance: Instance): Promise<{ readonly reason?: string; readonly seconds: readonly unknown[] }> {
  const finished = (run: Record<string, any>): boolean => run["applied"] === true && run["timedOut"] !== true;
  const clean = await runTests(instance, "");
  if (!finished(clean)) return { reason: "the clean run did not finish", seconds: [clean["seconds"]] };
  const bug = await runTests(instance, instance.patch);
  const seconds = [clean["seconds"], bug["seconds"]];
  if (!finished(bug)) return { reason: "the bug run did not finish", seconds };
  const status = (run: Record<string, any>, test: string): unknown => run["statuses"]?.[test];
  if (!instance.FAIL_TO_PASS.every((test) => status(clean, test) === "PASSED")) return { reason: "a failing test does not pass before the bug", seconds };
  if (instance.FAIL_TO_PASS.some((test) => status(bug, test) === "PASSED")) return { reason: "a failing test passes with the bug", seconds };
  return { seconds };
}

async function sample(): Promise<void> {
  const count = Number(option("count") ?? "20");
  const seed = option("seed") ?? "375";
  const tried = new Map(records().filter((record) => record["kind"] === "sample").map((record) => [record["instance"], record]));
  const byRepo = new Map<string, Instance[]>();
  for (const instance of instances.values()) byRepo.set(instance.repo, [...byRepo.get(instance.repo) ?? [], instance]);
  const repos = [...byRepo.keys()].sort((a, b) => hash(`${seed}|${a}`).localeCompare(hash(`${seed}|${b}`)));
  for (const repo of repos) {
    if (sampled().length >= count) break;
    const candidates = (byRepo.get(repo) ?? []).filter((instance) => instance.problem_statement.trim() !== "")
      .sort((a, b) => hash(`${seed}|${a.instance_id}`).localeCompare(hash(`${seed}|${b.instance_id}`))).slice(0, 3);
    for (const instance of candidates) {
      const known = tried.get(instance.instance_id);
      if (known?.["valid"] === true) break;
      if (known !== undefined) continue;
      const { reason, seconds } = await validate(instance);
      append({ kind: "sample", instance: instance.instance_id, repo, valid: reason === undefined, ...reason === undefined ? {} : { reason },
        seconds });
      process.stdout.write(`sample ${instance.instance_id}: ${reason ?? "valid"}\n`);
      if (reason === undefined) break;
    }
  }
}

async function review(): Promise<void> {
  const model = option("model") ?? "";
  if (model === "") throw new Error("Name the reviewer with --model=<provider/id>.");
  const done = new Set(records().filter((record) => record["kind"] === "review").map((record) =>
    `${record["model"]}|${record["instance"]}|${record["arm"]}`));
  const items = sampled().flatMap((instance) => ARMS.map((arm) => ({ instance, arm })))
    .filter(({ instance, arm }) => !done.has(`${model}|${instance.instance_id}|${arm}`));
  await pool(items, Number(option("parallel") ?? "4"), async ({ instance, arm }) => {
    const directory = changed(instance, arm);
    const session = await pi(model, directory, ["read", "grep", "find", "ls"], reviewPrompt(request(instance, arm), git(directory, "diff")));
    const findings = parseFindings(String(session["output"]));
    append({ kind: "review", model, instance: instance.instance_id, arm, findings: findings ?? [], parsed: findings !== undefined,
      ...session, output: String(session["output"]).slice(-3000) });
    process.stdout.write(`review ${model} ${instance.instance_id} ${arm}: ${findings === undefined ? "unparsed" : findings.length}\n`);
  });
}

interface Reviewed { readonly key: string; readonly model: string; readonly instance: Instance; readonly arm: Arm; readonly finding: Finding }

function allFindings(): Reviewed[] {
  return records().filter((record) => record["kind"] === "review").flatMap((record) => {
    const instance = instances.get(String(record["instance"]));
    return instance === undefined ? [] : (record["findings"] as Finding[]).map((finding, index) => ({
      key: `${record["model"]}|${instance.instance_id}|${record["arm"]}|${index}`, model: String(record["model"]), instance,
      arm: record["arm"] as Arm, finding }));
  });
}

/** Jev's triage of each finding: whether it describes behavior a test could show, so the gate is worth running. */
async function triage(): Promise<void> {
  const key = process.env["TYPESAFE_API_KEY"]?.trim();
  if (key === undefined || key === "") throw new Error("Set TYPESAFE_API_KEY for Jev.");
  const done = new Set(records().filter((record) => record["kind"] === "triage").map((record) => record["key"]));
  for (const item of allFindings().filter((entry) => !done.has(entry.key))) {
    const answered = await jevTriage(key, item.finding);
    append({ kind: "triage", key: item.key, ...answered });
    process.stdout.write(`triage ${item.key}: ${String(answered["probability"])}\n`);
  }
}

async function judge(): Promise<void> {
  const model = option("model") ?? "openai/gpt-6-sol";
  const done = new Set(records().filter((record) => record["kind"] === "judge").map((record) => record["key"]));
  await pool(allFindings().filter((item) => item.arm === "bug" && !done.has(item.key)), Number(option("parallel") ?? "4"), async (item) => {
    const directory = join(mkdtempSync(join(work, "judge-")), "empty");
    mkdirSync(directory);
    const session = await pi(model, directory, [], judgePrompt(item.instance, item.finding));
    const block = [...String(session["output"]).matchAll(/```json\s*([\s\S]*?)```/gu)].at(-1)?.[1];
    let real: boolean | null = null;
    let why = "";
    try {
      const parsed = JSON.parse(block ?? "") as { real?: unknown; why?: unknown };
      real = typeof parsed.real === "boolean" ? parsed.real : null;
      why = String(parsed.why ?? "");
    } catch { /* recorded as unjudged */ }
    append({ kind: "judge", key: item.key, model, real, why, tokens: session["tokens"], durationMs: session["durationMs"] });
    process.stdout.write(`judge ${item.key}: ${String(real)}\n`);
  });
}

/** The `tesota repro` tests of a run: how many ran, failed and passed. */
function repro(run: Record<string, any>): { readonly ran: number; readonly failed: number; readonly passed: number } {
  const statuses = Object.entries((run["statuses"] ?? {}) as Record<string, string>).filter(([name]) => name.toLowerCase().includes(MARK));
  return { ran: statuses.length, failed: statuses.filter(([, status]) => status === "FAILED" || status === "ERROR").length,
    passed: statuses.filter(([, status]) => status === "PASSED").length };
}

/** The bug's patch followed by `testPatch`; whitespace is kept, since a context line may be a single space. */
const withBug = (instance: Instance, testPatch: string): string =>
  `${instance.patch}${instance.patch.endsWith("\n") ? "" : "\n"}${testPatch}`;

/**
 * Runs again, on the change, the tests of gate records whose combined patch did not apply: before 2026-10-11 the
 * bug's patch was trimmed, which broke a hunk ending in a blank context line. Appends a corrected record, which the
 * score reads in place of the first.
 */
async function rerun(): Promise<void> {
  const model = option("model") ?? "openai/gpt-6-luna";
  const broken = records().filter((record) => record["kind"] === "gate" && record["model"] === model && record["wrote"] === true &&
    record["appliedOnChange"] === false && !String(record["key"]).includes("|control|"));
  const fixed = new Set(records().filter((record) => record["kind"] === "gate" && record["rerun"] === true).map((record) => record["key"]));
  for (const record of broken.filter((item) => !fixed.has(item["key"]))) {
    const instance = instances.get(String(record["key"]).split("|")[1] ?? "");
    if (instance === undefined) continue;
    const change = await runTests(instance, withBug(instance, String(record["testPatch"])));
    append({ ...record, at: undefined, rerun: true, onChange: repro(change), appliedOnChange: change["applied"] });
    process.stdout.write(`rerun ${String(record["key"])}: ${JSON.stringify(repro(change))}\n`);
  }
}

/**
 * The script beside `directory` the agent runs its tests with: the working tree's diff from the clean code, in the
 * instance's container, showing the `tesota repro` tests and, given `visible`, which of those tests do not pass.
 */
function agentScript(directory: string, instance: Instance, visible?: readonly string[]): string {
  const runs = join(directory, "..", "agent");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "instance.json"), JSON.stringify(instance));
  if (visible !== undefined) writeFileSync(join(runs, "visible.json"), JSON.stringify(visible));
  const script = forward(join(directory, "..", "run-tests.sh"));
  writeFileSync(script, ["#!/bin/bash", "export MSYS_NO_PATHCONV=1", "set -e", `cd "${forward(directory)}"`,
    "git -c core.autocrlf=false add -N .", `git -c core.autocrlf=false diff clean > "${forward(runs)}/change.diff"`,
    `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "${forward(runs)}:/work" ${IMAGE} python /opt/run.py ` +
    `--instance-file /work/instance.json --patch-file /work/change.diff --timeout ${TEST_TIMEOUT_S} --match "${MARK}"` +
    (visible === undefined ? "" : " --visible-file /work/visible.json"), ""].join("\n"));
  return script;
}

async function gate(): Promise<void> {
  const model = option("model") ?? "openai/gpt-6-luna";
  const done = new Set(records().filter((record) => record["kind"] === "gate" && record["model"] === model).map((record) => record["key"]));
  await pool(allFindings().filter((item) => !done.has(item.key)), parallel, async (item) => {
    const directory = changed(item.instance, item.arm);
    const script = agentScript(directory, item.instance);
    const session = await pi(model, directory, undefined, gatePrompt(request(item.instance, item.arm), item.finding, script));
    const paths = git(directory, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    const tests = paths.filter((path) => path.includes("tesota-repro"));
    const bugFiles = [...item.instance.patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
    const touched = paths.filter((path) => !path.includes("tesota-repro") && !bugFiles.includes(path));
    let outcome: Record<string, unknown> = {};
    if (tests.length > 0) {
      git(directory, "add", "-N", "--", ...tests);
      const testPatch = git(directory, "diff", "clean", "--", ...tests);
      const reference = await runTests(item.instance, testPatch);
      const change = item.arm === "control" ? reference : await runTests(item.instance, withBug(item.instance, testPatch));
      outcome = { onChange: repro(change), onReference: repro(reference), appliedOnChange: change["applied"],
        appliedOnReference: reference["applied"], testPatch };
    }
    append({ kind: "gate", model, key: item.key, wrote: tests.length > 0, tests, touched, ...outcome,
      durationMs: session["durationMs"], modelRequests: session["modelRequests"], tokens: session["tokens"],
      ...session["ended"] === "exited" && session["exitCode"] === 0 ? {} : { output: String(session["output"]).slice(-2000) } });
    process.stdout.write(`gate ${item.key}: ${tests.length === 0 ? "declined" : JSON.stringify(outcome["onChange"])}\n`);
  });
}

/**
 * The fix step (#375, step 3), registered on 2026-10-11 before any run. The instance's failing tests stay hidden from
 * the agent: they are the oracle, and every SWE-smith bug is caught by them by construction, so showing them would only
 * measure the test rung Tesota already has. The visible suite is `PASS_TO_PASS`, the tests that pass with the bug and
 * without it, as far as they pass on the change. Tesota's rule accepts a finding as evidence when its repro test failed
 * on the change, passes after the fix, no visible test breaks and no test file changed.
 */
const fixPrompt = (requested: string, finding: Finding, tests: readonly string[], script: string): string =>
  `A reviewer reported this finding about the uncommitted change in this repository (\`git diff\` shows it), made for this ` +
  `request:\n\n${requested}\n\nFinding: ${where(finding)}: ${finding.statement}\nReason: ${finding.reason}\n\n` +
  `${tests.join(", ")} reproduces it: its \`${MARK}\` tests fail on the current code. Fix the code so they pass, as the ` +
  "request asks, without breaking any other test. Do not change any test file. The tests run only in a container: " +
  `\`bash ${script}\` runs the repository's tests and shows the results of the \`${MARK}\` tests and of any other test ` +
  "that does not pass. If the finding is wrong, change nothing and say why.";

const isTestPath = (path: string): boolean =>
  path.includes("tesota-repro") || /(^|\/)(tests?|__tests__|specs?)\//iu.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/iu.test(path);

/** The change itself, over the clean code: the bug, or nothing for the control, whose fix restores the clean code. */
const changePatch = (instance: Instance, arm: Arm): string => arm === "bug" ? instance.patch : "";

/** The visible suite of an arm's change: the `PASS_TO_PASS` tests that pass on it, measured once and kept. */
async function visibleSuite(instance: Instance, arm: Arm): Promise<readonly string[]> {
  const known = records().find((record) => record["kind"] === "baseline" && record["instance"] === instance.instance_id &&
    record["arm"] === arm);
  if (known !== undefined) return known["visible"] as string[];
  const run = await runTests(instance, changePatch(instance, arm));
  const visible = instance.PASS_TO_PASS.filter((test) => run["statuses"]?.[test] === "PASSED");
  append({ kind: "baseline", instance: instance.instance_id, arm, visible });
  return visible;
}

async function fix(): Promise<void> {
  const model = option("model") ?? "openai/gpt-6-luna";
  const gateModel = option("gate-model") ?? "openai/gpt-6-luna";
  const gates = new Map(records().filter((record) => record["kind"] === "gate" && record["model"] === gateModel)
    .map((record) => [record["key"], record]));
  const done = new Set(records().filter((record) => record["kind"] === "fix" && record["model"] === model).map((record) => record["key"]));
  const confirmed = allFindings().filter((item) => !done.has(item.key) && gates.get(item.key)?.["wrote"] === true &&
    Number(gates.get(item.key)?.["onChange"]?.["failed"] ?? 0) > 0).slice(0, Number(option("limit") ?? Infinity));
  await pool(confirmed, parallel, async (item) => {
    const gated = gates.get(item.key) ?? {};
    const visible = await visibleSuite(item.instance, item.arm);
    const directory = changed(item.instance, item.arm);
    const testPatch = join(directory, "..", "repro.diff");
    writeFileSync(testPatch, String(gated["testPatch"]));
    git(directory, "apply", testPatch);
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "--no-verify", "-m", "before the fix");
    const tests = gated["tests"] as string[];
    const script = agentScript(directory, item.instance, visible);
    const session = await pi(model, directory, undefined, fixPrompt(request(item.instance, item.arm), item.finding, tests, script));
    const changedPaths = git(directory, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    const testsTouched = changedPaths.filter(isTestPath);
    const wroteFix = changedPaths.some((path) => !isTestPath(path));
    let outcome: Record<string, unknown> = {};
    if (wroteFix) {
      git(directory, "add", "-N", ".");
      const run = await runTests(item.instance, git(directory, "diff", "clean"));
      const broken = visible.filter((test) => run["statuses"]?.[test] !== "PASSED");
      outcome = { applied: run["applied"], reproAfter: repro(run), visible: visible.length, visibleBroken: broken.length,
        visibleBrokenNames: broken.slice(0, 10), hidden: { total: item.instance.FAIL_TO_PASS.length,
          passed: item.instance.FAIL_TO_PASS.filter((test) => run["statuses"]?.[test] === "PASSED").length } };
    }
    const after = outcome["reproAfter"] as ReturnType<typeof repro> | undefined;
    const accepted = wroteFix && testsTouched.length === 0 && after !== undefined && after.ran > 0 && after.failed === 0 &&
      outcome["visibleBroken"] === 0;
    append({ kind: "fix", model, key: item.key, wroteFix, changedPaths, testsTouched, ...outcome, accepted,
      durationMs: session["durationMs"], modelRequests: session["modelRequests"], tokens: session["tokens"],
      ...session["ended"] === "exited" && session["exitCode"] === 0 ? {} : { output: String(session["output"]).slice(-2000) } });
    process.stdout.write(`fix ${item.key}: ${wroteFix ? `accepted ${String(accepted)}, hidden ${JSON.stringify(outcome["hidden"])}` : "no fix"}\n`);
  });
}

/**
 * Cases the operator approves (the plain-language rules decision, step 4), registered on 2026-10-11 before any run.
 * A separate session that sees the request, the finding's claim and the code at the change, but neither the
 * reviewer's reason nor any fix, writes one or two cases in plain words and a test for each, without running
 * anything. The findings are every one on the controls and, for each bug, the finding first in the order of a SHA-256
 * of the seed and its key. A case's expectation is right when its test passes on the correct code, which the operator
 * never sees; it would confirm a finding when it also fails on the change.
 *
 * Version 2, registered on 2026-10-11 before any run of it: version 1's cases often named the code's internals, which
 * no one who knows only the request can judge (#397). A case now states what someone does and what they get, in the
 * request's own words; a finding that cannot be stated that way is declared not judgeable, writes no case, and
 * reaches the receipt as unverified.
 */
const CASE_PROMPT = 2;
const CASE_TESTS = "add one new test file whose name contains `tesota-case`, where the repository's test command runs it, " +
  "written like the repository's other tests, with one test per case named `tesota case 1`, `tesota case 2`, each " +
  "asserting exactly that case's expected result. Do not run anything and do not change any other file. ";
const casePrompt = (requested: string, finding: Finding): string =>
  `A reviewer claims this about the uncommitted change in this repository (\`git diff\` shows it), made for this ` +
  `request:\n\n${requested}\n\nClaim: ${where(finding)}: ${finding.statement}\n\n` +
  "Write one or two concrete cases that pin down the behavior the claim says is expected, for the person who made the " +
  "request to approve or reject. That person knows what they asked for but does not read code. State each case in the " +
  "request's own words: what someone does or gives, and what they get. Never name functions, variables, files, " +
  "internal states, timing or framework details. If the claim cannot be stated that way, because judging it needs the " +
  "code's internals, write no case and no test, and say why.\n\n" +
  `For the cases you write, ${CASE_TESTS}End your reply with a JSON object in a \`\`\`json block: ` +
  "{\"cases\": [{\"case\": 1, \"text\": \"the case in the request's words\"}], \"notJudgeable\": null}, or " +
  "{\"cases\": [], \"notJudgeable\": \"why the claim needs the code's internals\"}.";

/** The case records written with the current prompt; a record without a version came from the first. */
const currentCases = (): Record<string, any>[] =>
  records().filter((record) => record["kind"] === "cases" && (record["prompt"] ?? 1) === CASE_PROMPT);

/**
 * The findings cases are written for: every one on the controls and, for each bug, the first `--per-bug` (one, or
 * `all`) in the order of a SHA-256 of the seed and its key; `--source` keeps one reviewer's.
 */
function caseFindings(): Reviewed[] {
  const seed = option("seed") ?? "375";
  const perBug = option("per-bug") === "all" ? Infinity : Number(option("per-bug") ?? "1");
  const source = option("source");
  const all = allFindings().filter((item) => source === undefined || item.model === source);
  const bugs = [...new Set(all.filter((item) => item.arm === "bug").map((item) => item.instance.instance_id))].flatMap((id) =>
    all.filter((item) => item.arm === "bug" && item.instance.instance_id === id)
      .sort((a, b) => hash(`${seed}|${a.key}`).localeCompare(hash(`${seed}|${b.key}`))).slice(0, perBug));
  return [...all.filter((item) => item.arm === "control"), ...bugs];
}

interface Written { readonly case: number; readonly text: string }

/** The cases a session's reply lists in its last JSON block, with the rest of that object. */
function writtenCases(output: string): { readonly written: Written[]; readonly reply: Record<string, unknown> } {
  const block = [...output.matchAll(/```json\s*([\s\S]*?)```/gu)].at(-1)?.[1];
  try {
    const reply = JSON.parse(block ?? "{}") as Record<string, unknown>;
    const listed = Array.isArray(reply["cases"]) ? reply["cases"] as { case?: unknown; text?: unknown }[] : [];
    return { reply, written: listed.flatMap((entry) =>
      typeof entry.case === "number" && typeof entry.text === "string" ? [{ case: entry.case, text: entry.text }] : []) };
  } catch {
    return { reply: {}, written: [] };
  }
}

/** The session's `tesota-case` test files, run on the correct code and on the change, and each written case's outcome. */
async function runCases(instance: Instance, arm: Arm, directory: string, written: readonly Written[]): Promise<Record<string, unknown>> {
  const tests = git(directory, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim()).filter((path) => path.includes("tesota-case"));
  if (tests.length === 0 || written.length === 0) {
    return { tests, cases: written.map((entry) => ({ ...entry, onCorrect: "missing", onChange: "missing" })) };
  }
  git(directory, "add", "-N", "--", ...tests);
  const testPatch = git(directory, "diff", "clean", "--", ...tests);
  const correct = await runTests(instance, testPatch);
  const change = arm === "control" ? correct : await runTests(instance, withBug(instance, testPatch));
  return { tests, testPatch, cases: written.map((entry) => ({ ...entry, onCorrect: caseOutcome(correct, entry.case),
    onChange: caseOutcome(change, entry.case) })) };
}

/** How a numbered case's tests ended in a run: passed only when each of its tests ran and passed. */
function caseOutcome(run: Record<string, any>, number: number): "pass" | "fail" | "missing" {
  const statuses = Object.entries((run["statuses"] ?? {}) as Record<string, string>)
    .filter(([name]) => name.toLowerCase().includes(`tesota case ${number}`));
  if (statuses.length === 0) return "missing";
  return statuses.every(([, status]) => status === "PASSED") ? "pass" : "fail";
}

async function cases(): Promise<void> {
  const model = option("model") ?? "openai/gpt-6-sol";
  const done = new Set(currentCases().filter((record) => record["model"] === model).map((record) => record["key"]));
  await pool(caseFindings().filter((item) => !done.has(item.key)).slice(0, Number(option("limit") ?? Infinity)), parallel, async (item) => {
    const directory = changed(item.instance, item.arm);
    const session = await pi(model, directory, ["read", "grep", "find", "ls", "write"], casePrompt(request(item.instance, item.arm), item.finding));
    const { written, reply } = writtenCases(String(session["output"]));
    const notJudgeable = typeof reply["notJudgeable"] === "string" && reply["notJudgeable"].trim() !== "" ? reply["notJudgeable"] : undefined;
    const outcome = await runCases(item.instance, item.arm, directory, written);
    append({ kind: "cases", prompt: CASE_PROMPT, model, key: item.key, ...outcome,
      ...notJudgeable === undefined ? {} : { notJudgeable }, durationMs: session["durationMs"], tokens: session["tokens"],
      ...session["ended"] === "exited" && session["exitCode"] === 0 ? {} : { output: String(session["output"]).slice(-2000) } });
    process.stdout.write(`cases ${item.key}: ${JSON.stringify((outcome["cases"] as { onCorrect: string }[]).map((entry) => entry.onCorrect))}\n`);
  });
}

/**
 * The cases for the operator, as a JSON file: each with its request, the change's diff and the case in plain words,
 * in the order of a SHA-256 of the seed and its id, with nothing that tells how it ran or how its finding is labeled.
 */
function exportCases(): void {
  const file = option("file");
  if (file === undefined) throw new Error("Name the file with --file=<path>.");
  const seed = option("seed") ?? "375";
  const byKey = new Map(allFindings().map((item) => [item.key, item]));
  const diffs = new Map<string, string>();
  const diffOf = (item: Reviewed): string => {
    const id = `${item.instance.instance_id}|${item.arm}`;
    if (!diffs.has(id)) diffs.set(id, item.arm === "bug" ? item.instance.patch : git(changed(item.instance, "control"), "diff"));
    return diffs.get(id) ?? "";
  };
  const shown = currentCases().flatMap((record) => {
    const item = byKey.get(String(record["key"]));
    return item === undefined ? [] : (record["cases"] as { case: number; text: string }[]).map((entry) => ({
      id: hash(`${String(record["key"])}|${entry.case}`).slice(0, 12), request: request(item.instance, item.arm),
      diff: diffOf(item), text: entry.text }));
  }).sort((a, b) => hash(`${seed}|${a.id}`).localeCompare(hash(`${seed}|${b.id}`)));
  writeFileSync(file, JSON.stringify(shown, null, 1));
  process.stdout.write(`${shown.length} cases written to ${file}\n`);
}

/**
 * A reviewer that proposes checks, not verdicts (#397), registered on 2026-10-15 before any run. It reads the request
 * and the change and, for each defect it suspects, writes a case in the request's words with a test, or lists a gap
 * when the suspicion needs the code's internals. It never reports a bare finding; the harness runs each case's test on
 * the correct code and on the change, as for the cases stage.
 *
 * Version 2 (`--prompt=2`), registered on 2026-10-16 before any run of it: reviewers flag correct changes often, and a
 * prior stated over the whole set cut one model's false alarms without losing recall, where saying the item at hand is
 * correct cut recall too. Version 2 adds that prior and nothing about the change at hand.
 */
const CHECKS_PROMPT = 1;
const CLEAN_AWARE = "Many of the changes you review are correct, and there is no quota of cases: an empty list is a normal " +
  "answer. Write a case only when you have a concrete reason to believe this change fails the request or breaks behavior.\n\n";
const checksPrompt = (requested: string, diff: string, prompt: number): string =>
  `Review the uncommitted change in this repository (\`git diff\` shows it) against this request:\n\n${requested}\n\n` +
  (prompt === 2 ? CLEAN_AWARE : "") + "Do not report opinions. For each place where you suspect the change fails the request or breaks behavior, write a " +
  "concrete case that would show it, for the person who made the request to approve or reject. That person knows what " +
  "they asked for but does not read code. State each case in the request's own words: what someone does or gives, and " +
  "what they get when the change is right. Never name functions, variables, files, internal states, timing or framework " +
  "details. A suspicion that cannot be stated that way is a gap: list it with why, and write no case for it. Write no " +
  "case for behavior you do not suspect; you may read files.\n\n" +
  `For the cases you write, ${CASE_TESTS}End your reply with a JSON object in a \`\`\`json block: ` +
  "{\"cases\": [{\"case\": 1, \"text\": \"the case in the request's words\"}], \"gaps\": [{\"statement\": \"what you " +
  "suspect\", \"why\": \"why it needs the code's internals\"}]}, with empty lists when you suspect nothing.\n\n" +
  `The change, as \`git diff\` shows it:\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;

/** Whose cases a checks record holds: `checks:<model>` for the first prompt, `checks<n>:<model>` for a later one. */
const checksSource = (record: Record<string, any>): string =>
  `checks${(record["prompt"] ?? CHECKS_PROMPT) === CHECKS_PROMPT ? "" : String(record["prompt"])}:${String(record["model"])}`;

async function checks(): Promise<void> {
  const model = option("model") ?? "claude-bridge/claude-sonnet-5-5";
  const prompt = Number(option("prompt") ?? String(CHECKS_PROMPT));
  const done = new Set(records().filter((record) => record["kind"] === "checks" && record["model"] === model).map((record) => record["key"]));
  const items = sampled().flatMap((instance) => ARMS.map((arm) => ({ instance, arm,
    key: `${model}|${instance.instance_id}|${arm}|checks${prompt === CHECKS_PROMPT ? "" : prompt}` })))
    .filter((item) => !done.has(item.key)).slice(0, Number(option("limit") ?? Infinity));
  await pool(items, parallel, async ({ instance, arm, key }) => {
    const directory = changed(instance, arm);
    const session = await pi(model, directory, ["read", "grep", "find", "ls", "write"],
      checksPrompt(request(instance, arm), git(directory, "diff"), prompt));
    const { written, reply } = writtenCases(String(session["output"]));
    const gaps = Array.isArray(reply["gaps"]) ? reply["gaps"] : [];
    const outcome = await runCases(instance, arm, directory, written);
    append({ kind: "checks", prompt, model, key, instance: instance.instance_id, arm, ...outcome, gaps,
      parsed: Object.keys(reply).length > 0, durationMs: session["durationMs"], tokens: session["tokens"],
      ...session["ended"] === "exited" && session["exitCode"] === 0 ? {} : { output: String(session["output"]).slice(-2000) } });
    process.stdout.write(`checks ${key}: ${JSON.stringify((outcome["cases"] as { onCorrect: string; onChange: string }[])
      .map((entry) => `${entry.onCorrect}/${entry.onChange}`))}, gaps ${gaps.length}\n`);
  });
}

/** A command's stdout, kept apart from its stderr, and how it ended. */
function capture(command: string, args: readonly string[], cwd: string, timeoutMs: number):
  Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  return new Promise((settle) => {
    const child = spawn(command, [...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-20_000); });
    child.on("close", (code) => settle({ stdout, stderr, code }));
  });
}

/** An external review's text as findings, in the reviewer's format, read by a model with no tools. */
async function asFindings(review: string): Promise<{ readonly findings: Finding[] | undefined; readonly tokens: unknown }> {
  const directory = join(mkdtempSync(join(work, "parse-")), "empty");
  mkdirSync(directory);
  const session = await pi(option("parse-model") ?? "claude-bridge/claude-sonnet-5-5", directory, [],
    "Below is a code review. List each defect it reports, and nothing it does not report, as a JSON array in a ```json " +
    "block, one object per defect: {\"path\": \"src/file.js\", \"line\": 3, \"statement\": \"what is wrong\", \"reason\": " +
    `"why it is wrong"}. Use [] when it reports none.\n\n${review}`);
  return { findings: parseFindings(String(session["output"])), tokens: session["tokens"] };
}

/**
 * Claude Code's local `/code-review` as a source of findings, registered on 2026-10-15 before any run: run with
 * `claude -p` in each change's copy, at an explicit effort, its text then read into findings. Its findings go through
 * the cases stage like any reviewer's.
 */
async function codeReview(): Promise<void> {
  const model = option("model") ?? "claude-sonnet-5-5";
  const effort = option("effort") ?? "high";
  const label = `claude-code-review/${model}/${effort}`;
  const done = new Set(records().filter((record) => record["kind"] === "review" && record["model"] === label)
    .map((record) => `${record["instance"]}|${record["arm"]}`));
  const items = sampled().flatMap((instance) => ARMS.map((arm) => ({ instance, arm })))
    .filter(({ instance, arm }) => !done.has(`${instance.instance_id}|${arm}`)).slice(0, Number(option("limit") ?? Infinity));
  await pool(items, parallel, async ({ instance, arm }) => {
    const directory = changed(instance, arm);
    const started = Date.now();
    const ran = await capture("claude", ["-p", `/code-review ${effort}`, "--model", model, "--output-format", "json",
      "--allowedTools", "Read,Grep,Glob,Bash(git:*)"], directory, 30 * 60_000);
    let result: Record<string, any> = {};
    try { result = JSON.parse(ran.stdout) as Record<string, any>; } catch { /* recorded unparsed */ }
    const text = String(result["result"] ?? "");
    const read = text === "" ? { findings: undefined, tokens: undefined } : await asFindings(text);
    const usage = result["usage"] ?? {};
    append({ kind: "review", model: label, instance: instance.instance_id, arm, findings: read.findings ?? [],
      parsed: read.findings !== undefined, durationMs: Date.now() - started, costUsd: result["total_cost_usd"],
      tokens: { input: usage["input_tokens"], output: usage["output_tokens"], cacheRead: usage["cache_read_input_tokens"],
        total: ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
          .reduce((total, name) => total + Number(usage[name] ?? 0), 0) }, parseTokens: read.tokens,
      output: text.slice(-3000), ...ran.code === 0 ? {} : { code: ran.code, stderr: ran.stderr.slice(-2000) } });
    process.stdout.write(`code-review ${instance.instance_id} ${arm}: ${read.findings === undefined ? "unparsed" : read.findings.length}\n`);
  });
}

/**
 * One ultrareview run (`claude ultrareview --json`) on one change the operator allotted, against the clean commit;
 * its findings go through the cases stage like any reviewer's.
 */
async function ultrareview(): Promise<void> {
  const instance = instances.get(option("instance") ?? "");
  const arm = option("arm") as Arm | undefined;
  if (instance === undefined || arm === undefined || !ARMS.includes(arm)) throw new Error("Name --instance=<id> and --arm=bug|control.");
  if (records().some((record) => record["kind"] === "review" && record["model"] === "claude-ultrareview")) {
    throw new Error("The one ultrareview run is already recorded.");
  }
  const directory = changed(instance, arm);
  const started = Date.now();
  const ran = await capture("claude", ["ultrareview", "--json", "--timeout", "45", git(directory, "rev-parse", "HEAD").trim()],
    directory, 50 * 60_000);
  const read = ran.code === 0 && ran.stdout.trim() !== "" ? await asFindings(ran.stdout) : { findings: undefined, tokens: undefined };
  append({ kind: "review", model: "claude-ultrareview", instance: instance.instance_id, arm, findings: read.findings ?? [],
    parsed: read.findings !== undefined, durationMs: Date.now() - started, raw: ran.stdout.slice(-20_000), parseTokens: read.tokens,
    code: ran.code, stderr: ran.stderr.slice(-4000) });
  process.stdout.write(`ultrareview ${instance.instance_id} ${arm}: ${read.findings === undefined ? `failed: ${ran.stderr.slice(-500)}` : read.findings.length}\n`);
}

/** A written case, wherever it came from: the cases stage, by the reviewer whose finding it pins, or the checks stage. */
interface ProposedCase {
  readonly id: string; readonly source: string; readonly instance: Instance; readonly arm: Arm; readonly text: string;
  readonly onCorrect: string; readonly onChange: string; readonly number: number; readonly testPatch: string;
}

function proposedCases(): ProposedCase[] {
  return [...currentCases(), ...records().filter((record) => record["kind"] === "checks")]
    .flatMap((record) => {
      const [reviewer, id, arm] = String(record["key"]).split("|");
      const instance = instances.get(id ?? "");
      const source = record["kind"] === "checks" ? checksSource(record) : String(reviewer);
      return instance === undefined ? [] : (record["cases"] as (Written & { onCorrect: string; onChange: string })[]).map((entry) => ({
        id: `${String(record["key"])}|${entry.case}`, source, instance, arm: arm as Arm, text: entry.text, onCorrect: entry.onCorrect,
        onChange: entry.onChange, number: entry.case, testPatch: String(record["testPatch"] ?? "") }));
    });
}

/**
 * A model standing in for the operator (#397), registered on 2026-10-15 before any run: it sees the request, the
 * change's diff and one case, not the repository or how the case's test ran, and says whether the expectation is right.
 * `--source` names whose cases, `--arm` keeps one arm's, `--limit` caps how many, in the order of a SHA-256 of the seed
 * and the case's id.
 *
 * Version 2 (`--prompt=2`), registered on 2026-10-15 before any run of it: studies find that a model shown the code
 * writes what the code does rather than what it should do, so the judge never sees the change. It sees the request and
 * what the request makes the specification: for a refactor that keeps behavior, the changed files as they were before
 * the change; for a bug report, the report alone. It answers whether the case follows from that, contradicts it, or is
 * left unsettled, with the question the operator would be asked; only a case that follows is approved.
 */
const approvePrompt = (requested: string, diff: string, text: string): string =>
  `Someone asked for this change to a project:\n\n${requested}\n\nThe change, as a diff:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
  `A reviewer says that, when the change is right, the project behaves like this:\n\n${text}\n\nYou stand in for the ` +
  "person who made the request. Judging only from the request and the change, is this expected behavior right, wrong, " +
  "or can you not tell? Answer only with a JSON object in a ```json block: {\"verdict\": \"right\" or \"wrong\" or " +
  "\"unsure\", \"why\": \"one sentence\"}.";

const SPEC_FILE_LIMIT = 80_000;
const approvePrompt2 = (requested: string, specification: string, text: string): string =>
  `Someone asked for this change to a project:\n\n${requested}\n\n${specification}A reviewer says that, when the change ` +
  `is right, the project behaves like this:\n\n${text}\n\nYou stand in for the person who made the request. You do not ` +
  "see the change itself. Judge only from the request and what is given above: does this expected behavior follow from " +
  "them, contradict them, or do they leave it unsettled? Answer unsettled whenever they do not decide it, and say the " +
  "one question you would ask the person. Answer only with a JSON object in a ```json block: {\"verdict\": \"follows\" " +
  "or \"contradicts\" or \"unsettled\", \"why\": \"one sentence\", \"question\": \"the question, or null\"}.";

/** What the request makes the specification: the files a refactor changes, as they were before; nothing for a bug report. */
function specificationOf(instance: Instance, arm: Arm): string {
  if (arm === "control") return "";
  const directory = cleanCopy(instance);
  const files = [...instance.patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1] ?? "");
  return "Since the request keeps behavior, the behavior to keep is these files' behavior before the change:\n\n" +
    files.map((file) => `${file}:\n\n\`\`\`\n${readFileSync(join(directory, file), "utf8").slice(0, SPEC_FILE_LIMIT)}\n\`\`\`\n\n`).join("");
}

const approveVerdicts: Readonly<Record<number, readonly string[]>> = { 1: ["right", "wrong", "unsure"], 2: ["follows", "contradicts", "unsettled"] };
const approvedAs: Readonly<Record<number, string>> = { 1: "right", 2: "follows" };

async function approve(): Promise<void> {
  const model = option("model") ?? "claude-bridge/claude-opus-5-5";
  const source = option("source");
  if (source === undefined) throw new Error("Name whose cases with --source=<reviewer model or checks:model>.");
  const seed = option("seed") ?? "375";
  const prompt = Number(option("prompt") ?? "1");
  // A case with no verdict, such as one asked while the model's quota was spent, is asked again.
  const done = new Set(records().filter((record) => record["kind"] === "approve" && record["model"] === model &&
    (record["prompt"] ?? 1) === prompt && record["verdict"] !== null).map((record) => record["case"]));
  const contexts = new Map<string, string>();
  const contextOf = (item: ProposedCase): string => {
    const id = `${item.instance.instance_id}|${item.arm}`;
    if (!contexts.has(id)) {
      contexts.set(id, prompt === 2 ? specificationOf(item.instance, item.arm)
        : item.arm === "bug" ? item.instance.patch : git(changed(item.instance, "control"), "diff"));
    }
    return contexts.get(id) ?? "";
  };
  const arm = option("arm");
  const items = proposedCases().filter((item) => item.source === source && (arm === undefined || item.arm === arm) && !done.has(item.id))
    .sort((a, b) => hash(`${seed}|${a.id}`).localeCompare(hash(`${seed}|${b.id}`))).slice(0, Number(option("limit") ?? Infinity));
  await pool(items, parallel, async (item) => {
    const directory = join(mkdtempSync(join(work, "approve-")), "empty");
    mkdirSync(directory);
    const asked = prompt === 2 ? approvePrompt2(request(item.instance, item.arm), contextOf(item), item.text)
      : approvePrompt(request(item.instance, item.arm), contextOf(item), item.text);
    const session = await pi(model, directory, [], asked);
    const parsed = lastJson(String(session["output"]));
    const verdict = typeof parsed["verdict"] === "string" && approveVerdicts[prompt]?.includes(parsed["verdict"]) ? parsed["verdict"] : null;
    append({ kind: "approve", prompt, model, case: item.id, source, verdict, why: String(parsed["why"] ?? ""),
      ...typeof parsed["question"] === "string" ? { question: parsed["question"] } : {}, tokens: session["tokens"],
      durationMs: session["durationMs"] });
    process.stdout.write(`approve ${item.id}: ${String(verdict)}\n`);
  });
}

/** The last JSON object in a fenced block of a reply; empty when there is none to read. */
function lastJson(reply: string): Record<string, unknown> {
  const block = [...reply.matchAll(/```json\s*([\s\S]*?)```/gu)].at(-1)?.[1];
  try {
    const parsed: unknown = JSON.parse(block ?? "");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Whether a case's test checks that case (#397), registered on 2026-10-15 before any run: a case judged right can
 * still fail on correct code when its test does not check what it says. A model sees one case and the test file that
 * holds its test, not the code under test, and says whether that test passes exactly when the case holds.
 */
const faithfulPrompt = (text: string, number: number, testPatch: string): string =>
  `A case, stated in plain words:\n\n${text}\n\nThe test meant to check it is the one named \`tesota case ${number}\` in ` +
  `this new test file:\n\n\`\`\`diff\n${testPatch}\n\`\`\`\n\nJudge only the test against the case, not whether the case ` +
  "is right: does that test give the same input and assert the same result, nothing more and nothing less, so that it " +
  "passes exactly when the case holds? Answer only with a JSON object in a ```json block: {\"verdict\": \"yes\" or \"no\" " +
  "or \"unsure\", \"why\": \"one sentence\"}.";

async function faithful(): Promise<void> {
  const model = option("model") ?? "claude-bridge/claude-sonnet-5-5";
  const source = option("source");
  const arm = option("arm");
  const done = new Set(records().filter((record) => record["kind"] === "faithful" && record["model"] === model && record["verdict"] !== null)
    .map((record) => record["case"]));
  const items = proposedCases().filter((item) => (source === undefined || item.source === source) &&
    (arm === undefined || item.arm === arm) && item.testPatch !== "" && !done.has(item.id)).slice(0, Number(option("limit") ?? Infinity));
  await pool(items, parallel, async (item) => {
    const directory = join(mkdtempSync(join(work, "faithful-")), "empty");
    mkdirSync(directory);
    const session = await pi(model, directory, [], faithfulPrompt(item.text, item.number, item.testPatch));
    const parsed = lastJson(String(session["output"]));
    const verdict = parsed["verdict"] === "yes" || parsed["verdict"] === "no" || parsed["verdict"] === "unsure" ? parsed["verdict"] : null;
    append({ kind: "faithful", model, case: item.id, source: item.source, verdict, why: String(parsed["why"] ?? ""),
      tokens: session["tokens"], durationMs: session["durationMs"] });
    process.stdout.write(`faithful ${item.id}: ${String(verdict)}\n`);
  });
}

/**
 * A refuter between the reviewer and the operator (#397), registered on 2026-10-16 before any run: a model asked to
 * approve a case let wrong ones through, so this one is asked to refute it, from the request and the repository, and
 * only a case it lets stand reaches the operator. What the change currently does counts for neither side, since the
 * case's own test settles that. No verdict lets the case stand.
 */
const refutePrompt = (requested: string, text: string): string =>
  `A reviewer proposes this case about the uncommitted change in this repository (\`git diff\` shows it), made for this ` +
  `request:\n\n${requested}\n\nCase: ${text}\n\nThe case says what should happen when the change is right. Refute it if ` +
  "you can: look for a concrete reason the case is wrong or not required. Reasons that count: the request does not ask " +
  "for the case's result, or settles it differently (quote the request); the situation the case describes cannot happen " +
  "in this project (name where it is prevented). Whether the change currently gives the case's result counts for neither " +
  "side. Do not edit any file; you may read files. If you find no such reason, the case stands. End your reply with a " +
  "JSON object in a ```json block: {\"verdict\": \"refuted\" or \"stands\", \"reason\": \"one sentence\", \"evidence\": " +
  "\"the quote, or the file and line\"}.";

async function refute(): Promise<void> {
  const model = option("model") ?? "claude-bridge/claude-sonnet-5-5";
  const source = option("source");
  if (source === undefined) throw new Error("Name whose cases with --source=<checks source>.");
  const done = new Set(records().filter((record) => record["kind"] === "refute" && record["model"] === model && record["verdict"] !== null)
    .map((record) => record["case"]));
  const items = proposedCases().filter((item) => item.source === source && !done.has(item.id)).slice(0, Number(option("limit") ?? Infinity));
  await pool(items, parallel, async (item) => {
    const directory = changed(item.instance, item.arm);
    const session = await pi(model, directory, ["read", "grep", "find", "ls"], refutePrompt(request(item.instance, item.arm), item.text));
    const parsed = lastJson(String(session["output"]));
    const verdict = parsed["verdict"] === "refuted" || parsed["verdict"] === "stands" ? parsed["verdict"] : null;
    append({ kind: "refute", model, case: item.id, source, verdict, reason: String(parsed["reason"] ?? ""),
      evidence: String(parsed["evidence"] ?? ""), tokens: session["tokens"], durationMs: session["durationMs"] });
    process.stdout.write(`refute ${item.id}: ${String(verdict)}\n`);
  });
}

/**
 * The reviewer arms of #397 in the operator's terms: controls with at least one case shown, bugs with a shown case whose
 * test passes on the correct code and fails on the change, and cases shown per change. A source with refuter verdicts
 * gives a second row that shows only the cases the refuter let stand.
 */
function scoreArms(): void {
  const all = records();
  const refuter = option("refuter") ?? "claude-bridge/claude-sonnet-5-5";
  const refutes = all.filter((record) => record["kind"] === "refute" && record["model"] === refuter);
  const refuted = new Set(refutes.filter((record) => record["verdict"] === "refuted").map((record) => record["case"]));
  const proposed = proposedCases();
  const checked = all.filter((record) => record["kind"] === "checks");
  const lines: string[] = [];
  for (const source of [...new Set(checked.map(checksSource))].sort()) {
    const reviewed = (arm: Arm): number => checked.filter((record) => checksSource(record) === source && record["arm"] === arm).length;
    const mine = proposed.filter((item) => item.source === source);
    const refutedHere = refutes.filter((record) => record["source"] === source);
    const rows: [string, (item: ProposedCase) => boolean, number][] = [[source, () => true, 0],
      ...refutedHere.length > 0 ? [[`${source} + refuter`, (item: ProposedCase) => !refuted.has(item.id), tokens(refutedHere)] as
        [string, (item: ProposedCase) => boolean, number]] : []];
    for (const [name, shown, extra] of rows) {
      const kept = mine.filter(shown);
      const of = (arm: Arm): ProposedCase[] => kept.filter((item) => item.arm === arm);
      const instancesOf = (items: readonly ProposedCase[]): number => new Set(items.map((item) => item.instance.instance_id)).size;
      const perChange = (arm: Arm): string => reviewed(arm) === 0 ? "-" : (of(arm).length / reviewed(arm)).toFixed(2);
      lines.push(`| ${name} | ${instancesOf(of("control"))}/${reviewed("control")} | ` +
        `${instancesOf(of("bug").filter((item) => item.onCorrect === "pass" && item.onChange === "fail"))}/${reviewed("bug")} | ` +
        `${perChange("control")} | ${perChange("bug")} | ` +
        `${tokens(checked.filter((record) => checksSource(record) === source)) + extra} |`);
    }
  }
  process.stdout.write(["| Arm | Controls with a case shown | Bugs caught, perfect approver | Cases per control | Cases per bug | Tokens |",
    "| --- | --- | --- | --- | --- | --- |", ...lines, "",
    `Refuter ${refuter}: ${refutes.length} cases judged, ${refuted.size} refuted, ` +
    `${refutes.filter((record) => record["verdict"] === null).length} without a verdict (shown).`, ""].join("\n"));
}

/**
 * Checks as evidence, per source and arm: a case becomes evidence when it is approved and fails on the change. The
 * perfect approver approves exactly the cases whose test passes on the correct code; the model approver is `--model`'s
 * verdicts, over the cases it judged. On a control every evidence is false.
 */
function scoreChecks(): void {
  const all = records();
  const model = option("model") ?? "claude-bridge/claude-opus-5-5";
  const verdictsOf = (kind: string, test: (record: Record<string, any>) => boolean): Map<unknown, unknown> =>
    new Map(all.filter((record) => record["kind"] === kind && record["verdict"] !== null && test(record))
      .map((record) => [record["case"], record["verdict"]]));
  const approvals = [1, 2].map((prompt) => verdictsOf("approve", (record) => record["model"] === model && (record["prompt"] ?? 1) === prompt));
  const faithfulness = verdictsOf("faithful", (record) => record["model"] === (option("faithful-model") ?? "claude-bridge/claude-sonnet-5-5"));
  const proposed = proposedCases();
  const lines: string[] = [];
  for (const source of [...new Set(proposed.map((item) => item.source))].sort()) {
    for (const arm of ARMS) {
      const mine = proposed.filter((item) => item.source === source && item.arm === arm);
      const evidence = (kept: readonly ProposedCase[]): number => new Set(kept.filter((item) => item.onChange === "fail")
        .map((item) => item.instance.instance_id)).size;
      const approval = (prompt: number): string => {
        const verdicts = approvals[prompt - 1] ?? new Map();
        const judged = mine.filter((item) => verdicts.has(item.id));
        const approved = judged.filter((item) => verdicts.get(item.id) === approvedAs[prompt]);
        return `${judged.length} | ${approved.length} | ${evidence(approved)}`;
      };
      const second = approvals[1] ?? new Map();
      const judgedBoth = mine.filter((item) => second.has(item.id) && faithfulness.has(item.id));
      lines.push(`| ${source} | ${arm} | ${mine.length} | ${mine.filter((item) => item.onCorrect === "pass").length} | ` +
        `${mine.filter((item) => item.onChange === "fail").length} | ${evidence(mine.filter((item) => item.onCorrect === "pass"))} | ` +
        `${approval(1)} | ${approval(2)} | ${mine.filter((item) => second.get(item.id) === "unsettled").length} | ` +
        `${judgedBoth.length} | ${evidence(judgedBoth.filter((item) => second.get(item.id) === "follows" && faithfulness.get(item.id) === "yes"))} |`);
    }
  }
  const checked = all.filter((record) => record["kind"] === "checks");
  const spent = (kind: string, test: (record: Record<string, any>) => boolean = () => true): string =>
    [...new Set(all.filter((record) => record["kind"] === kind && test(record)).map((record) => String(record["model"])))]
      .map((name) => `${name} ${tokens(all.filter((record) => record["kind"] === kind && record["model"] === name))}`).join(", ");
  process.stdout.write(["| Source | Arm | Cases | Right (test passes on correct) | Fail on change | Instances with evidence, " +
    "perfect approver | v1 judged | v1 approved | v1 evidence | v2 judged | v2 follows | v2 evidence | v2 unsettled | " +
    "v2 and test judged | v2 follows, test checks it: evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...lines, "", `Gaps listed by checks: ${checked.reduce((total, record) => total + (record["gaps"] as unknown[]).length, 0)} over ` +
    `${checked.length} changes; unparsed ${checked.filter((record) => record["parsed"] !== true).length}.`,
    `Tokens: checks ${spent("checks")}; cases ${spent("cases", (record) => record["prompt"] === CASE_PROMPT)}; review ${spent("review")}; ` +
    `approve ${spent("approve")}; faithful ${spent("faithful")}; /code-review in dollars, as it reports no tokens: ${all.filter((record) => record["kind"] === "review" &&
      String(record["model"]).startsWith("claude-code-review/")).reduce((total, record) => total + Number(record["costUsd"] ?? 0), 0).toFixed(2)}.`,
    ""].join("\n"));
}

const tokens = (records: readonly Record<string, any>[]): number => records.reduce((total, record) => total + Number(record["tokens"]?.["total"] ?? 0), 0);

function score(): void {
  const all = records();
  const gateModel = option("model") ?? "openai/gpt-6-luna";
  const triageOf = new Map(all.filter((record) => record["kind"] === "triage").map((record) => [record["key"], record["probability"]]));
  const judged = new Map(all.filter((record) => record["kind"] === "judge").map((record) => [record["key"], record["real"]]));
  const gates = new Map(all.filter((record) => record["kind"] === "gate" && record["model"] === gateModel).map((record) => [record["key"], record]));
  const fixes = new Map(all.filter((record) => record["kind"] === "fix" && record["model"] === (option("fix-model") ?? gateModel))
    .map((record) => [record["key"], record]));
  const items = allFindings().map((item) => {
    const gated = gates.get(item.key);
    const confirmed = gated === undefined ? undefined : gated["wrote"] === true && Number(gated["onChange"]?.["failed"] ?? 0) > 0;
    return { ...item, real: item.arm === "control" ? false : judged.get(item.key) as boolean | null | undefined,
      triage: triageOf.get(item.key) as number | null | undefined, gated, confirmed, fixed: fixes.get(item.key) };
  });
  const reviews = all.filter((record) => record["kind"] === "review");
  const lines: string[] = [];
  for (const model of new Set(items.map((item) => item.model))) {
    for (const arm of ARMS) {
      const mine = items.filter((item) => item.model === model && item.arm === arm);
      const reviewed = reviews.filter((record) => record["model"] === model && record["arm"] === arm).length;
      const row = (name: string, kept: typeof mine): string => {
        const real = kept.filter((item) => item.real === true);
        const falses = kept.filter((item) => item.real === false).length;
        const caught = new Set(real.map((item) => item.instance.instance_id)).size;
        return `| ${model} | ${arm} | ${name} | ${kept.length} | ${real.length} | ${falses} | ` +
          `${kept.filter((item) => item.real === null || item.real === undefined).length} | ` +
          `${real.length + falses === 0 ? "-" : (real.length / (real.length + falses)).toFixed(2)} | ` +
          `${arm === "bug" ? `${caught}/${reviewed}` : `${new Set(kept.map((item) => item.instance.instance_id)).size}/${reviewed}`} |`;
      };
      const confirmed = mine.filter((item) => item.confirmed === true);
      // What each triage would skip: those findings reach the operator unverified; the gate tokens they cost are saved.
      const skipped = (name: string, skips: typeof mine): string => `${name} skips ${skips.length} (real ${skips.filter((item) =>
        item.real === true).length}, gate tokens saved ${tokens(skips.flatMap((item) => item.gated ?? []))})`;
      // The fix step: accepted by Tesota's rule, and what the hidden failing tests say about each accepted fix.
      const accepted = confirmed.filter((item) => item.fixed?.["accepted"] === true);
      const hiddenAll = (item: (typeof mine)[number]): boolean => item.fixed?.["hidden"]?.["passed"] === item.fixed?.["hidden"]?.["total"];
      const fixLine = `|  |  | fix: confirmed ${confirmed.length}, tried ${confirmed.filter((item) => item.fixed !== undefined).length}, ` +
        `no fix ${confirmed.filter((item) => item.fixed !== undefined && item.fixed["wroteFix"] !== true).length}, touched tests ` +
        `${confirmed.filter((item) => (item.fixed?.["testsTouched"] ?? []).length > 0).length}, broke visible tests ` +
        `${confirmed.filter((item) => Number(item.fixed?.["visibleBroken"] ?? 0) > 0).length}; accepted ${accepted.length} ` +
        `(real ${accepted.filter((item) => item.real === true).length}, false ${accepted.filter((item) => item.real === false).length}); ` +
        `hidden tests ${arm === "bug" ? "all pass" : "still all pass"} after ${accepted.filter(hiddenAll).length}/${accepted.length} ` +
        "accepted fixes | | | | | | |";
      lines.push(row("raw", mine), row(`gate (${gateModel})`, confirmed), row("gate + fix", accepted), fixLine,
        `|  |  | triage: ${skipped(`Jev below ${JEV_SKIP_BELOW}`, mine.filter((item) => jevSkips(item.triage)))}; ` +
        `${skipped("B1", mine.filter((item) => ruleSkips(item.finding, diffFiles(item.instance.patch))))}; Jev unanswered ` +
        `${mine.filter((item) => typeof item.triage !== "number").length} | | | | | | |`,
        `|  |  | gate: judged ${mine.filter((item) => item.gated !== undefined).length}, declined ` +
        `${mine.filter((item) => item.gated !== undefined && item.gated["wrote"] !== true).length}, wrote but no ${MARK} test ran on ` +
        `the change ${mine.filter((item) => item.gated?.["wrote"] === true && Number(item.gated["onChange"]?.["ran"] ?? 0) === 0).length}, ` +
        `confirmed and passing on the reference ${confirmed.filter((item) => Number(item.gated?.["onReference"]?.["failed"] ?? 1) === 0 &&
          Number(item.gated?.["onReference"]?.["ran"] ?? 0) > 0).length}/${confirmed.length} | | | | | | |`);
    }
  }
  process.stdout.write(["| Reviewer | Arm | Findings | n | Real | False | Unjudged | Precision | Instances caught or flagged |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...lines, "",
    `Tokens: review ${tokens(reviews)}, judge ${tokens(all.filter((record) => record["kind"] === "judge"))}, gate ` +
    `${tokens([...gates.values()])}, fix ${tokens([...fixes.values()])}; Jev triage decisions ${triageOf.size}; sampled ${sampled().length}; unparsed reviews ` +
    `${reviews.filter((record) => record["parsed"] !== true).length}.`, ""].join("\n"));
  const table = option("table");
  if (table !== undefined) {
    const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
    const counts = (value: unknown): string => value === undefined ? "-" : JSON.stringify(value);
    writeFileSync(table, ["| Key | Finding | Real | Triage | Gate | Change | Reference |", "| --- | --- | --- | --- | --- | --- | --- |",
      ...items.map((item) => `| ${cell(item.key)} | ${cell(`${where(item.finding)}: ${item.finding.statement} — ${item.finding.reason}`)} | ` +
        `${String(item.real)} | ${typeof item.triage === "number" ? item.triage.toFixed(2) : "-"} | ` +
        `${item.gated === undefined ? "-" : item.gated["wrote"] !== true ? "declined" : item.confirmed === true ? "confirmed" : "killed"} | ` +
        `${counts(item.gated?.["onChange"])} | ${counts(item.gated?.["onReference"])} |`)].join("\n") + "\n");
  }
}

const stage = option("stage");
if (stage === "sample") await sample();
else if (stage === "review") await review();
else if (stage === "triage") await triage();
else if (stage === "judge") await judge();
else if (stage === "gate") await gate();
else if (stage === "rerun") await rerun();
else if (stage === "fix") await fix();
else if (stage === "cases") await cases();
else if (stage === "export-cases") exportCases();
else if (stage === "score") score();
else if (stage === "checks") await checks();
else if (stage === "code-review") await codeReview();
else if (stage === "ultrareview") await ultrareview();
else if (stage === "approve") await approve();
else if (stage === "faithful") await faithful();
else if (stage === "refute") await refute();
else if (stage === "score-arms") scoreArms();
else if (stage === "score-checks") scoreChecks();
else throw new Error("Use --stage=sample, review, triage, judge, gate, rerun, fix, cases, export-cases, score, checks, code-review, " +
  "ultrareview, approve, faithful, refute, score-checks or score-arms.");
