import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { FIRST_CONTRACT_CASES, HELD_OUT, LEFT_OPEN, OPEN_CASES } from "./cases.js";

/**
 * Whether a model can list the cases a request leaves open, for #397,
 * measured before anything is built. Each item is a request from #387's
 * live runs (`LEFT_OPEN`) with, in the `change` context, the file one run
 * of it wrote; five runs per request, chosen by a seeded shuffle of the runs
 * in `--runs`, the folder of `live:eval` results. The model answers through
 * a tool, and each answer appends one JSON line to `--out`, which a later
 * call resumes from. Registered on 2026-10-15 before any run, with the
 * thresholds a receipt section must meet: the listed cases cover at least
 * two thirds of the open cases `LEFT_OPEN` names, and the controls average
 * at most one false alarm a request, a listed case the request settles.
 * That measurement, #418, used this prompt without its last sentence.
 *
 * In the `held-out` context each item is a request from `HELD_OUT`, alone,
 * five times. Registered on 2026-10-15 before any run, with the thresholds
 * the receipt's list must meet before it ships: the listed cases cover at
 * least two thirds of the open cases `HELD_OUT` names, the requests that
 * settle every case average at most one false alarm, and all requests
 * average at most half an input of a kind the request never mentions.
 *
 *   bun evaluation/open-cases.ts --runs=<dir> --out=<file> --context=request|change|held-out [--model=openai/gpt-6-luna]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out");
const runs = option("runs");
const context = option("context") ?? "";
const model = option("model") ?? "openai/gpt-6-luna";
if (out === undefined || runs === undefined) throw new Error("Name --runs=<dir> and --out=<file>, both outside the repository.");
if (!["request", "change", "held-out"].includes(context)) throw new Error("Use --context=request, change or held-out.");
delete process.env["OPENAI_API_KEY"];

const requests = new Map<string, { request: string; path?: string }>([...OPEN_CASES, ...FIRST_CONTRACT_CASES,
  ...Object.entries(HELD_OUT).map(([name, { request }]) => ({ name, request, path: "" }))].map((testCase) => [testCase.name, testCase]));

/** Five runs of each request in `LEFT_OPEN`, by a seeded shuffle of the results files' runs; each `HELD_OUT` request five times. */
function items(): { case: string; file: string; run: number; after: string }[] {
  if (context === "held-out") return Object.keys(HELD_OUT).flatMap((name) => [1, 2, 3, 4, 5].map((run) => ({ case: name, file: "held-out", run, after: "" })));
  const all = readdirSync(runs ?? "").filter((name) => /^(oc|fc)-.*\.jsonl$/u.test(name)).flatMap((file) =>
    readFileSync(join(runs ?? "", file), "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((record) => record["kind"] === undefined && String(record["case"]) in LEFT_OPEN && typeof record["after"] === "string")
      .map((record) => ({ case: String(record["case"]), file, run: Number(record["run"]), after: String(record["after"]) })));
  let seed = 397;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shuffled = all.sort((a, b) => `${a.file}|${a.case}|${a.run}` < `${b.file}|${b.case}|${b.run}` ? -1 : 1)
    .map((item) => ({ item, key: random() })).sort((a, b) => a.key - b.key).map(({ item }) => item);
  return Object.keys(LEFT_OPEN).flatMap((name) => shuffled.filter((item) => item.case === name).slice(0, 5));
}

const answer = Type.Object({ cases: Type.Array(Type.Object({ input: Type.String(), outcomes: Type.Array(Type.String()) })) });

function prompt(request: string, path: string, after: string): string {
  return `A person gave a coding agent this request:\n\n${request}\n\n` +
    (context === "change" ? `The agent wrote this file, ${path}:\n\n${after}\n\n` : "") +
    "List each input case the request does not settle: an input for which a reasonable person who made the request could " +
    "expect more than one result. For each, give the input and the results someone could expect. Leave out cases the " +
    "request settles, and anything about how the code or its proof is written. If the request settles every case, list none. " +
    "Leave out inputs of a kind the request never mentions, such as NaN, Infinity, -0, or values that are not of the type it names.";
}

const registry = new ModelRegistry(await ModelRuntime.create());
const slash = model.indexOf("/");
const chosen = registry.find(model.slice(0, slash), model.slice(slash + 1));
if (chosen === undefined) throw new Error(`${model} is not in Pi's model registry.`);
const done = new Set((() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })().split("\n")
  .filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>)
  .map((record) => `${record["model"]}|${record["context"]}|${record["file"]}|${record["case"]}|${record["run"]}`));
for (const item of items()) {
  if (done.has(`${model}|${context}|${item.file}|${item.case}|${item.run}`)) continue;
  const testCase = requests.get(item.case);
  if (testCase === undefined || testCase.path === undefined) throw new Error(`No registered request for ${item.case}.`);
  const reply = await registry.complete(chosen, {
    systemPrompt: "You read requests people give coding agents and find what they leave open. Answer only through the tool you are given.",
    messages: [{ role: "user", content: [{ type: "text", text: prompt(testCase.request, testCase.path, item.after) }], timestamp: Date.now() }],
    tools: [{ name: "open_cases", description: "Record the open cases. Call it exactly once.", parameters: answer }],
  }, { signal: AbortSignal.timeout(300_000) });
  const call = reply.content.find((part) => part.type === "toolCall" && part.name === "open_cases");
  const listed = call?.type === "toolCall" && Value.Check(answer, call.arguments) ? (call.arguments as { cases: unknown[] }).cases : undefined;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  appendFileSync(out, `${JSON.stringify({ model, context, file: item.file, case: item.case, run: item.run,
    ...listed === undefined ? { error: reply.errorMessage ?? `stopped: ${reply.stopReason}` } : { cases: listed },
    usage: reply.usage, at: new Date().toISOString() })}\n`);
  process.stdout.write(`${context} ${item.case} (${item.file} run ${item.run}): ${listed === undefined ? "no answer" : `${listed.length} cases`}\n`);
}
