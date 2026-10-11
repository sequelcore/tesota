import { spawnSync } from "node:child_process";
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
else if (stage === "score") score();
else throw new Error("Use --stage=sample, review, triage, judge, gate, rerun, fix or score.");
