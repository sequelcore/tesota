import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type SessionResult, session } from "./engine-session.js";
import type { Finding } from "./finding-cases.js";
import { read } from "./sessions.js";

/**
 * What the findings evaluations (#375) share: the command line, the results
 * file, the reviewer's and Jev's questions, registered on 2026-10-10 before
 * any run, and a model's session.
 */

export const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);

// The models come from the operator's sign-in, never an API key.
delete process.env["OPENAI_API_KEY"];

/** The results file: one JSON line per record, which a later call resumes from. */
export function results(out: string | undefined): { records: () => Record<string, any>[]; append: (record: Record<string, unknown>) => void } {
  if (out === undefined) throw new Error("Name the results file with --out=<file>, outside the repository.");
  return {
    records: () => (read(out) ?? "").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>),
    append: (record) => {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      appendFileSync(out, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
    },
  };
}

/** Runs `work` on each item, `parallel` at a time. */
export async function pool<T>(items: readonly T[], parallel: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => {
    while (next < items.length) await work(items[next++] as T);
  }));
}

export function git(directory: string, ...args: string[]): string {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
    { cwd: directory, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
}

export const reviewPrompt = (request: string, diff: string): string =>
  `Review the uncommitted change in this repository against this request:\n\n${request}\n\n` +
  "Report only defects: places where the change fails the request or breaks behavior. Do not edit any file; you may read " +
  "files. End your reply with a JSON array in a ```json block, one object per defect: " +
  "{\"path\": \"src/file.js\", \"line\": 3, \"statement\": \"what is wrong\", \"reason\": \"why it is wrong\"}. " +
  `Use [] when there is none.\n\nThe change, as \`git diff\` shows it:\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;

export const where = (finding: Finding): string =>
  `${finding.path ?? "(no file)"}${finding.line === undefined ? "" : `:${finding.line}`}`;

/** The last fenced JSON array in a reply, as findings; undefined when there is none to read. */
export function parseFindings(reply: string): Finding[] | undefined {
  const blocks = [...reply.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
  const last = blocks.at(-1);
  if (last === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((item: Record<string, unknown>) => typeof item?.["statement"] !== "string" ? [] : [{
      ...typeof item["path"] === "string" ? { path: item["path"] } : {},
      ...typeof item["line"] === "number" ? { line: item["line"] } : {},
      statement: item["statement"], reason: typeof item["reason"] === "string" ? item["reason"] : "" }]);
  } catch {
    return undefined;
  }
}

/**
 * A session in `directory` (`session`), on the engine without Tesota or through `claude -p`: `tools` names the tools
 * it may use, none when empty, and a coding agent's when undefined.
 */
export async function agent(model: string, directory: string, tools: readonly string[] | undefined, prompt: string):
  Promise<Omit<SessionResult, "facts">> {
  const ran = await session({ model, directory, ...tools === undefined ? {} : { tools }, prompt, timeoutMs: 20 * 60_000 });
  return { ended: ran.ended, exitCode: ran.exitCode, output: ran.output, durationMs: ran.durationMs, modelRequests: ran.modelRequests,
    tokens: ran.tokens };
}

/**
 * Jev's role here, registered on 2026-10-11 before any run: triage of the gate, the costly and discretionary step,
 * as decision 035 used it for the answer check and #124 allows. It never judges whether a finding is true. Asked one
 * question from the finding alone, a finding below `JEV_SKIP_BELOW` would skip the gate and reach the operator as
 * unverified, never removed; an error, a refusal or no answer decides nothing, so the gate runs. Pinned to the
 * version decision 035 qualified.
 */
export const JEV_SKIP_BELOW = 0.2;
const JEV_MODEL = "jev-1.13.0";

const triageQuestion = {
  type: "noul",
  instructions: "Does this code review finding describe behavior of the code that a test could show?",
  criteria: {
    true: "The finding says what the code does or returns for some input, call or state, or what it fails to do, " +
      "so running the code could show it.",
    false: "The finding is only about style, naming, structure, comments, documentation, missing tests or design, " +
      "with no behavior a test could show.",
  },
};

/** Jev's probability that a finding describes testable behavior, on the operator's TypeSafe key. */
export async function jevTriage(apiKey: string, finding: Finding): Promise<Record<string, unknown>> {
  const started = Date.now();
  const response = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, questions: { testable: triageQuestion },
      state: { finding: `${where(finding)}: ${finding.statement} Reason: ${finding.reason}` } }) });
  const body: unknown = response.ok ? await response.json() : await response.text();
  const answered = typeof body === "object" && body !== null ? Reflect.get(body, "model") : undefined;
  const probability = typeof body === "object" && body !== null
    ? Reflect.get(Reflect.get(Reflect.get(body, "answers") ?? {}, "testable") ?? {}, "noul") : undefined;
  return { status: response.status, ms: Date.now() - started, answeredBy: answered,
    probability: typeof probability === "number" ? probability : null, ...typeof probability === "number" ? {} : { body } };
}

/** Whether Jev's triage would skip the gate: only on a probability below the threshold; no answer decides nothing. */
export const jevSkips = (probability: unknown): boolean => typeof probability === "number" && probability < JEV_SKIP_BELOW;

/**
 * B1, the fixed rule Jev must beat, registered with it: the gate runs when the finding names a file the change
 * touches and a line, and does not speak of style, names or tests; otherwise it is skipped.
 */
export function ruleSkips(finding: Finding, changedFiles: readonly string[]): boolean {
  const path = finding.path?.replaceAll("\\", "/");
  const located = path !== undefined && finding.line !== undefined && changedFiles.some((file) => path.endsWith(file));
  const offTopic = /\b(style|naming|rename|readabilit|comment|documentation|test coverage|missing tests?|untested|no tests?)\b/iu
    .test(`${finding.statement} ${finding.reason}`);
  return !located || offTopic;
}

/** The files a diff changes, from its `+++ b/` lines. */
export const diffFiles = (diff: string): string[] => [...diff.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1] ?? "");
