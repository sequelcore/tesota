import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDING_CASES, type Finding, type FindingCase, label } from "./finding-cases.js";
import { JEV_SKIP_BELOW, git, jevSkips, jevTriage, option, parseFindings, pi, pool, results, reviewPrompt, ruleSkips, where }
  from "./review-session.js";
import { manifest, read, write } from "./sessions.js";

/**
 * Findings as evidence (#375), measured before it is built: whether turning
 * each review finding into a reproduction test that must fail on the change
 * removes false findings without losing real ones. Every stage appends JSON
 * lines to `--out`, and a later call resumes from them.
 *
 * - `review`: a model reviews each case's uncommitted change through `pi -p`,
 *   with read-only tools, and lists its findings.
 * - `triage`: TypeSafe's Jev, a typed decision model, gives each finding a
 *   probability of describing behavior a test could show, to decide only
 *   whether the gate is worth running, never whether the finding is true
 *   (`JEV_SKIP_BELOW` in `review-session.ts`). It needs `TYPESAFE_API_KEY`.
 * - `gate`: an agent turns each finding, and each case's planted false claim,
 *   into `repro/finding.test.js` or declines; the test then runs on fresh
 *   copies of the base, the change and the case's correct reference.
 * - `score`: the findings raw and after the gate, what each triage would
 *   skip, and a Markdown table of every finding to check the labels by hand
 *   with `--table=<file>`.
 *
 *   bun run findings:eval --out=<file> --stage=review --model=openai/gpt-6-sol [--runs=1] [--cases=<name>,<name>]
 *   bun run findings:eval --out=<file> --stage=triage
 *   bun run findings:eval --out=<file> --stage=gate [--model=openai/gpt-6-luna]
 *   bun run findings:eval --out=<file> --stage=score [--model=<gate model>] [--table=<file>]
 *
 * The models come from the operator's Pi sign-in: `OPENAI_API_KEY` is removed
 * and stdin is closed. `--parallel=N` runs that many sessions at once.
 */
const { records, append } = results(option("out"));
const parallel = Number(option("parallel") ?? "3");
const TEST_PATH = "repro/finding.test.js";

const gatePrompt = (request: string, finding: Finding): string =>
  `A reviewer reported this finding about the uncommitted change in this repository (\`git diff\` shows it), made for this ` +
  `request:\n\n${request}\n\nFinding: ${where(finding)}: ${finding.statement}\nReason: ${finding.reason}\n\n` +
  `Turn the finding into a reproduction test: write \`${TEST_PATH}\`, a \`node:test\` test that imports the changed code, ` +
  "fails on the current code because of exactly this defect, and will pass once the defect is fixed as the request asks. " +
  `Run it with \`node --test ${TEST_PATH}\` to see it fail. Do not change any other file. If the finding is wrong, so that ` +
  "no such test fails on the current code, do not write the file, and say why.";

/** A fresh Git repository with the base committed and the candidate written over it, uncommitted. */
function changed(testCase: FindingCase): string {
  const directory = join(mkdtempSync(join(tmpdir(), "tesota-findings-")), "project");
  write(directory, { ...testCase.base, "package.json": manifest, ".gitignore": "node_modules\n" });
  git(directory, "init", "-q");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "base");
  write(directory, testCase.candidate);
  git(directory, "add", "-N", ".");
  return directory;
}


function chosenCases(): readonly FindingCase[] {
  const names = option("cases")?.split(",");
  const cases = names === undefined ? FINDING_CASES : FINDING_CASES.filter((testCase) => names.includes(testCase.name));
  if (names !== undefined && cases.length !== names.length) throw new Error(`Unknown case among ${names.join(", ")}.`);
  return cases;
}

async function review(): Promise<void> {
  const model = option("model") ?? "";
  if (model === "") throw new Error("Name the reviewer with --model=<provider/id>.");
  const runs = Number(option("runs") ?? "1");
  const done = new Set(records().filter((record) => record["kind"] === "review").map((record) =>
    `${record["model"]}|${record["case"]}|${record["run"]}`));
  const work = Array.from({ length: runs }, (_, k) => chosenCases().map((testCase) => ({ testCase, run: k + 1 }))).flat()
    .filter(({ testCase, run }) => !done.has(`${model}|${testCase.name}|${run}`));
  await pool(work, parallel, async ({ testCase, run }) => {
    const directory = changed(testCase);
    const session = await pi(model, directory, ["read", "grep", "find", "ls"], reviewPrompt(testCase.request, git(directory, "diff")));
    const findings = parseFindings(String(session["output"]));
    append({ kind: "review", model, case: testCase.name, run, findings: findings ?? [], parsed: findings !== undefined,
      ...session, output: String(session["output"]).slice(-3000) });
    process.stdout.write(`review ${model} ${testCase.name} ${run}: ${findings === undefined ? "unparsed" : `${findings.length} findings`}\n`);
  });
}

/** Every finding to judge: each review's, keyed by its review and place, and each case's planted false claim. */
function allFindings(): { readonly key: string; readonly source: string; readonly testCase: FindingCase; readonly finding: Finding }[] {
  const reviewed = records().filter((record) => record["kind"] === "review").flatMap((record) => {
    const testCase = FINDING_CASES.find((item) => item.name === record["case"]);
    return testCase === undefined ? [] : (record["findings"] as Finding[]).map((finding, index) => ({
      key: `${record["model"]}|${testCase.name}|${record["run"]}|${index}`, source: String(record["model"]), testCase, finding }));
  });
  const planted = FINDING_CASES.flatMap((testCase) => testCase.falseClaim === undefined ? []
    : [{ key: `planted|${testCase.name}`, source: "planted", testCase, finding: testCase.falseClaim }]);
  return [...reviewed, ...planted];
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

/** Whether the test passes on a fresh copy of these files. */
function runsGreen(files: Readonly<Record<string, string>>, testText: string): boolean {
  const directory = mkdtempSync(join(tmpdir(), "tesota-repro-"));
  write(directory, { ...files, "package.json": manifest, [TEST_PATH]: testText });
  return spawnSync("node", ["--test", TEST_PATH], { cwd: directory, encoding: "utf8", timeout: 60_000 }).status === 0;
}

async function gate(): Promise<void> {
  const model = option("model") ?? "openai/gpt-6-luna";
  const done = new Set(records().filter((record) => record["kind"] === "gate" && record["model"] === model).map((record) => record["key"]));
  await pool(allFindings().filter((entry) => !done.has(entry.key)), parallel, async ({ key, testCase, finding }) => {
    const directory = changed(testCase);
    const session = await pi(model, directory, undefined, gatePrompt(testCase.request, finding));
    const testText = read(join(directory, TEST_PATH));
    const expected = { ...testCase.base, ...testCase.candidate };
    const touched = git(directory, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim()).filter((path) => !path.startsWith("repro/") &&
        read(join(directory, path)) !== expected[path] && path !== "package.json" && path !== ".gitignore");
    const outcomes = testText === undefined ? {} : {
      passesOnBase: runsGreen(testCase.base, testText),
      passesOnChange: runsGreen(expected, testText),
      passesOnReference: runsGreen({ ...expected, ...testCase.reference }, testText) };
    append({ kind: "gate", model, key, wrote: testText !== undefined, ...outcomes, touched, testText,
      durationMs: session["durationMs"], modelRequests: session["modelRequests"], tokens: session["tokens"],
      ...session["ended"] === "exited" && session["exitCode"] === 0 ? {} : { output: String(session["output"]).slice(-2000) } });
    process.stdout.write(`gate ${key}: ${testText === undefined ? "declined" : `fails on change ${String(!outcomes.passesOnChange)}`}\n`);
  });
}

function score(): void {
  const all = records();
  const triageOf = new Map(all.filter((record) => record["kind"] === "triage").map((record) => [record["key"], record["probability"]]));
  const gateModel = option("model") ?? "openai/gpt-6-luna";
  const gates = all.filter((record) => record["kind"] === "gate" && record["model"] === gateModel);
  const items = allFindings().map((item) => {
    const gated = gates.find((record) => record["key"] === item.key);
    return { ...item, label: label(item.testCase, item.finding), triage: triageOf.get(item.key) as number | null | undefined, gated,
      confirmed: gated === undefined ? undefined : gated["wrote"] === true && gated["passesOnChange"] === false };
  });
  const reviews = all.filter((record) => record["kind"] === "review");
  const lines: string[] = [];
  for (const source of new Set(items.map((item) => item.source))) {
    const mine = items.filter((item) => item.source === source);
    const planted = source === "planted" ? 0 : reviews.filter((record) => record["model"] === source).reduce((total, record) =>
      total + (FINDING_CASES.find((testCase) => testCase.name === record["case"])?.defects.length ?? 0), 0);
    const row = (name: string, kept: typeof mine): string => {
      const defects = kept.filter((item) => item.label.kind === "defect");
      const found = new Set(defects.map((item) => item.key.split("|").slice(0, 3).join("|") + `|${item.label.kind === "defect" ? item.label.defect : ""}`));
      const falses = kept.filter((item) => item.label.kind === "false").length;
      return `| ${source} | ${name} | ${kept.length} | ${defects.length} | ${kept.filter((item) => item.label.kind === "acceptable").length} | ` +
        `${falses} | ${defects.length + falses === 0 ? "-" : (defects.length / (defects.length + falses)).toFixed(2)} | ` +
        `${planted === 0 ? "-" : `${found.size}/${planted}`} |`;
    };
    lines.push(row("raw", mine), row("gate", mine.filter((item) => item.confirmed === true)));
    const confirmed = mine.filter((item) => item.confirmed === true);
    // What each triage would skip: those findings reach the operator unverified; the gate tokens they cost are saved.
    const skipped = (name: string, skips: typeof mine): string => `${name} skips ${skips.length} (planted defect ` +
      `${skips.filter((item) => item.label.kind === "defect").length}, gate tokens saved ${skips.reduce((total, item) =>
        total + Number(item.gated?.["tokens"]?.["total"] ?? 0), 0)})`;
    lines.push(`|  | triage: ${skipped(`Jev below ${JEV_SKIP_BELOW}`, mine.filter((item) => jevSkips(item.triage)))}; ` +
      `${skipped("B1", mine.filter((item) => ruleSkips(item.finding, Object.keys(item.testCase.candidate))))}; Jev unanswered ` +
      `${mine.filter((item) => typeof item.triage !== "number").length} | | | | | | |`);
    lines.push(`|  | gate: judged ${mine.filter((item) => item.gated !== undefined).length}, declined ` +
      `${mine.filter((item) => item.gated !== undefined && item.gated["wrote"] !== true).length}, confirmed and passing on the reference ` +
      `${confirmed.filter((item) => item.gated?.["passesOnReference"] === true).length}/${confirmed.length}, touched other files ` +
      `${mine.filter((item) => (item.gated?.["touched"] ?? []).length > 0).length} | | | | | | |`);
  }
  const tokens = (kind: string): number => (kind === "gate" ? gates : all.filter((record) => record["kind"] === kind)).reduce((total, record) =>
    total + Number(record["tokens"]?.["total"] ?? 0), 0);
  process.stdout.write(["| Source | Findings | n | Planted defect | Accepted remark | False | Precision | Defects found |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |", ...lines, "",
    `Tokens: review ${tokens("review")}, gate ${tokens("gate")}; Jev triage decisions ${triageOf.size}; unparsed reviews ` +
    `${reviews.filter((record) => record["parsed"] !== true).length}.`, ""].join("\n"));
  const table = option("table");
  if (table !== undefined) {
    const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
    writeFileSync(table, ["| Key | Finding | Label | Triage | Gate | Base | Change | Reference |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...items.map((item) => `| ${cell(item.key)} | ${cell(`${where(item.finding)}: ${item.finding.statement} — ${item.finding.reason}`)} | ` +
        `${item.label.kind} | ${typeof item.triage === "number" ? item.triage.toFixed(2) : "-"} | ` +
        `${item.gated === undefined ? "-" : item.gated["wrote"] !== true ? "declined" : item.confirmed === true ? "confirmed" : "killed"} | ` +
        ["passesOnBase", "passesOnChange", "passesOnReference"].map((field) => item.gated?.[field] === undefined ? "-"
          : item.gated[field] === true ? "pass" : "fail").join(" | ") + " |")].join("\n") + "\n");
  }
}

const stage = option("stage");
if (stage === "review") await review();
else if (stage === "triage") await triage();
else if (stage === "gate") await gate();
else if (stage === "score") score();
else throw new Error("Use --stage=review, triage, gate or score.");
