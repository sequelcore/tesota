import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openCases } from "../src/open-cases.js";
import { engineRegistry } from "./engine-session.js";
import { FIRST_CONTRACT_CASES, FRESH, HELD_OUT, LEFT_OPEN, OPEN_CASES, SETTLED, STANDARD } from "./cases.js";

/**
 * Whether a model can list the cases a request leaves open, for #397,
 * through `openCases`, the receipt's own call. Each answer appends one JSON
 * line to `--out`, which a later call resumes from.
 *
 * In the `request` context each item is a request from #387's live runs
 * (`LEFT_OPEN`), five per request, chosen by a seeded shuffle of the runs in
 * `--runs`, the folder of `live:eval` results. Registered on 2026-10-15
 * before any run, with the thresholds a receipt section must meet: the
 * listed cases cover at least two thirds of the open cases `LEFT_OPEN`
 * names, and the controls average at most one false alarm a request, a
 * listed case the request settles. That measurement, #418, used the prompt
 * without its last sentence and also tried the request with the file one run
 * wrote, which listed more false alarms; it ran from `ef11562b`.
 *
 * In the `held-out` context each item is a request from `HELD_OUT`, alone,
 * five times. Registered on 2026-10-15 before any run, with the thresholds
 * the receipt's list must meet before it ships: the listed cases cover at
 * least two thirds of the open cases `HELD_OUT` names, the requests that
 * settle every case average at most one false alarm, and all requests
 * average at most half an input of a kind the request never mentions.
 *
 * The `settled` context does the same with `SETTLED`, registered after the
 * held-out false alarms passed only through a ruling made once they were
 * seen: the list passes when these requests average at most one false
 * alarm each, labelled by the rule `SETTLED` states.
 *
 * The `standard` context does the same with `STANDARD`, for #429, registered
 * on 2026-10-17 before any run, labelled by the rule `STANDARD` states. A
 * prompt passes when, on the `held-out`, `settled` and `standard` contexts
 * together, it meets the held-out thresholds above; the share of requests that
 * settle every case and still get any false alarm is reported beside them.
 * The `fresh` context does the same with `FRESH`, registered after a first
 * change was measured there, so that a second is judged on unread requests.
 * An answer's line names neither the prompt nor its version, so each prompt
 * measured writes to its own `--out`.
 *
 *   bun evaluation/open-cases.ts --out=<file> --context=request|held-out|settled|standard|fresh [--runs=<dir>] [--model=openai/gpt-6-sol]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out");
const runs = option("runs");
const context = option("context") ?? "";
const model = option("model") ?? "openai/gpt-6-sol";
if (out === undefined) throw new Error("Name --out=<file>, outside the repository.");
if (!["request", "held-out", "settled", "standard", "fresh"].includes(context)) {
  throw new Error("Use --context=request, held-out, settled, standard or fresh.");
}
if (context === "request" && runs === undefined) throw new Error("The request context reads #387's runs: name --runs=<dir>.");
delete process.env["OPENAI_API_KEY"];

const fresh = { "held-out": HELD_OUT, settled: SETTLED, standard: STANDARD, fresh: FRESH }[context];
const requests = new Map<string, string>([...OPEN_CASES, ...FIRST_CONTRACT_CASES,
  ...Object.entries(fresh ?? {}).map(([name, { request }]) => ({ name, request }))].map((testCase) => [testCase.name, testCase.request]));

/** Five runs of each request in `LEFT_OPEN`, by a seeded shuffle of the results files' runs; each new request five times. */
function items(): { case: string; file: string; run: number }[] {
  if (fresh !== undefined) return Object.keys(fresh).flatMap((name) => [1, 2, 3, 4, 5].map((run) => ({ case: name, file: context, run })));
  const all = readdirSync(runs ?? "").filter((name) => /^(oc|fc)-.*\.jsonl$/u.test(name)).flatMap((file) =>
    readFileSync(join(runs ?? "", file), "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((record) => record["kind"] === undefined && String(record["case"]) in LEFT_OPEN && typeof record["after"] === "string")
      .map((record) => ({ case: String(record["case"]), file, run: Number(record["run"]) })));
  let seed = 397;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shuffled = all.sort((a, b) => `${a.file}|${a.case}|${a.run}` < `${b.file}|${b.case}|${b.run}` ? -1 : 1)
    .map((item) => ({ item, key: random() })).sort((a, b) => a.key - b.key).map(({ item }) => item);
  return Object.keys(LEFT_OPEN).flatMap((name) => shuffled.filter((item) => item.case === name).slice(0, 5));
}

const ctx = { model: undefined, modelRegistry: await engineRegistry() };
const done = new Set((() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })().split("\n")
  .filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>)
  .map((record) => `${record["model"]}|${record["context"]}|${record["file"]}|${record["case"]}|${record["run"]}`));
for (const item of items()) {
  if (done.has(`${model}|${context}|${item.file}|${item.case}|${item.run}`)) continue;
  const request = requests.get(item.case);
  if (request === undefined) throw new Error(`No registered request for ${item.case}.`);
  const listed = await openCases(ctx, [request], model, new AbortController().signal);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  appendFileSync(out, `${JSON.stringify({ model, context, file: item.file, case: item.case, run: item.run,
    ...listed.status === "listed" ? { cases: listed.cases } : { error: listed.reason }, at: new Date().toISOString() })}\n`);
  process.stdout.write(`${context} ${item.case} (${item.file} run ${item.run}): ${listed.status === "listed" ? `${listed.cases.length} cases` : "no answer"}\n`);
}
