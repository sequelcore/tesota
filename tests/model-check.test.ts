import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { checkModel, inProject, modelContent, modelHeader, modelReport, plannedModels, tlcCounterexample, unheadedReport } from "../src/model-check.js";
import { GateOperations } from "../src/operations.js";
import { counterexampleSteps } from "../src/receipt.js";

/** The operator's TLC, where Tesota looks for it in their home; the runs that need it are skipped without it, as proofs are without Dafny. */
const operator = JSON.parse(process.env["TESOTA_TEST_OPERATOR_HOME"] ?? "{}") as { HOME?: string; USERPROFILE?: string };
const jar = join(operator.USERPROFILE ?? operator.HOME ?? "", ".tesota", "tools", "tla2tools.jar");
const withTlc = existsSync(jar) && spawnSync("java", ["-version"]).status === 0;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Two processes adding one to a counter in two steps, read then write; the lock makes the pair atomic when `Locked`. */
const spec = (module: string, header: string): string => `${header}
---- MODULE ${module} ----
EXTENDS Naturals
CONSTANT Locked
VARIABLES count, pc, tmp, lock
vars == <<count, pc, tmp, lock>>
Procs == {1, 2}
Init == count = 0 /\\ pc = [p \\in Procs |-> "read"] /\\ tmp = [p \\in Procs |-> 0] /\\ lock = 0
Read(p) == pc[p] = "read" /\\ (Locked => lock = 0) /\\ lock' = (IF Locked THEN p ELSE lock)
  /\\ tmp' = [tmp EXCEPT ![p] = count] /\\ pc' = [pc EXCEPT ![p] = "write"] /\\ UNCHANGED count
Write(p) == pc[p] = "write" /\\ count' = tmp[p] + 1 /\\ pc' = [pc EXCEPT ![p] = "done"]
  /\\ lock' = (IF Locked THEN 0 ELSE lock) /\\ UNCHANGED tmp
Done == \\A p \\in Procs : pc[p] = "done"
Next == (\\E p \\in Procs : Read(p) \\/ Write(p)) \\/ (Done /\\ UNCHANGED vars)
Spec == Init /\\ [][Next]_vars
NoLostUpdate == Done => count = 2
====
`;

const header = (confirmed: string, fault = "models/CounterNoLock.cfg the lock removed"): string => `(* tesota-model
   covers: src/counter.ts increment
   confirmed: ${confirmed}
   invariant: NoLostUpdate
   atomic: reading and writing the counter are separate steps
   omits: crashes; more than two processes
   fault: ${fault}
*)`;

const config = (locked: boolean): string => `SPECIFICATION Spec\nCONSTANT Locked = ${locked ? "TRUE" : "FALSE"}\n`;

/** A repository with the counter's code committed, and its model as `files` give it, uncommitted. */
function repository(files: (base: string) => Record<string, string>): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "tesota-model-"));
  roots.push(root);
  write(root, { "src/counter.ts": "export async function increment(): Promise<void> {}\n" });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  write(root, files(base));
  return { root, base };
}

it("reads one header format in TLA+ and Quint comments", () => {
  const tla = modelHeader(`${header("abc123")}\n---- MODULE M ----\n====\n`);
  expect(tla).toEqual({ covers: [{ path: "src/counter.ts", names: ["increment"] }], confirmed: "abc123", invariants: ["NoLostUpdate"],
    atomic: ["reading and writing the counter are separate steps"], omits: ["crashes; more than two processes"],
    faults: [{ path: "models/CounterNoLock.cfg", description: "the lock removed" }] });
  const quint = modelHeader("// tesota-model\n// covers: a.ts f g\n// invariant: one, two\n// replay: bun test x\nmodule m {}\n");
  expect(quint).toEqual({ covers: [{ path: "a.ts", names: ["f", "g"] }], invariants: ["one", "two"], atomic: [], omits: [], faults: [],
    replay: "bun test x" });
  expect(modelHeader("---- MODULE M ----\n====\n")).toBeUndefined();
});

it("tells a counterexample as numbered steps in the model's names, each with what it changed", () => {
  const output = ["Error: Invariant NoLostUpdate is violated.", "Error: The behavior up to this point is:", "State 1: <Initial predicate>",
    "/\\ count = 0", "/\\ pc = <<\"read\", \"read\">>", "", "State 2: <Read line 7, col 12 to line 8, col 92 of module Counter>",
    "/\\ count = 0", "/\\ pc = <<\"write\", \"read\">>", "", "State 3: <write(2) line 49, col 3 to line 52, col 18 of module counter>",
    "/\\ count = 1", "/\\ pc = <<\"write\",", "  \"done\">>", "", "13 states generated, 12 distinct states found, 3 states left on queue."].join("\r\n");
  const found = tlcCounterexample(output);
  expect(found?.violation).toBe("Invariant NoLostUpdate is violated.");
  expect(found === undefined ? [] : counterexampleSteps(found)).toEqual(["1. initial state: count = 0, pc = <<\"read\", \"read\">>",
    "2. Read: pc = <<\"write\", \"read\">>", "3. write(2): count = 1, pc = <<\"write\", \"done\">>"]);
  expect(tlcCounterexample("Model checking completed. No error has been found.")).toBeUndefined();
});

it("plans the models a request touched, and finds the models it changed with no header", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false), "models/Other.tla": spec("Other", ""), "models/Other.cfg": config(true),
    "models/Helper.tla": "---- MODULE Helper ----\n====\n" }));
  const touched = await plannedModels(root, ["src/counter.ts", "models/Other.tla", "models/Helper.tla"]);
  expect(touched.models.map(({ path, touched: changed }) => [path, changed])).toEqual([["models/Counter.tla", true]]);
  expect(touched.unheaded).toEqual(["models/Other.tla"]);
  expect((await plannedModels(root, ["README.md"])).models[0]?.touched).toBe(false);
  expect(unheadedReport(touched.unheaded)).toContain("tesota-model");
});

it("sends back a header that misses a part, without running TLC", async () => {
  const { root } = repository(() => ({ "models/Counter.tla": spec("Counter", "(* tesota-model\n   covers: src/counter.ts\n*)"),
    "models/Counter.cfg": config(true) }));
  const check = await checkModel(root, "models/Counter.tla", ["models/Counter.tla"], new AbortController().signal, jar);
  expect(check.evidence.outcome).toBe("failed");
  expect(check.problems).toHaveLength(3);
  expect(check.staleness).toBe("unknown");
  expect(modelReport(check)).toContain("names no invariant");
});

it("sends back a Quint model that starts with a byte-order mark, which Quint rejects", async () => {
  const { root } = repository(() => ({ "models/counter.qnt": `﻿/* tesota-model\n   covers: src/counter.ts\n   invariant: safe\n` +
    "   atomic: each step\n   omits: crashes\n   fault: models/racy.qnt no lock\n*/\nmodule counter {}\n" }));
  const check = await checkModel(root, "models/counter.qnt", ["models/counter.qnt"], new AbortController().signal, jar);
  expect(check.language).toBe("quint");
  expect(check.problems).toEqual(["the file starts with a byte-order mark, which Quint rejects"]);
  expect(check.evidence.outcome).toBe("failed");
});

it("asks for an invariant's name when the header states it in words, and never takes a fault copied with its header for a model", async () => {
  const { root } = repository((base) => ({
    "models/Counter.tla": spec("Counter", header(base).replace("invariant: NoLostUpdate", "invariant: no update is lost")),
    "models/Counter.cfg": config(true), "models/CounterNoLock.cfg": config(false),
    "models/Racy.tla": spec("Racy", header(base, "models/Copy.tla a copy")), "models/Racy.cfg": config(false),
    "models/Copy.tla": spec("Copy", header(base)), "models/Copy.cfg": config(false) }));
  const check = await checkModel(root, "models/Counter.tla", ["models/Counter.tla"], new AbortController().signal, jar);
  expect(check.problems).toEqual(["`no update is lost` is not the name of a definition: `invariant:` takes the names of the model's " +
    "invariant definitions, separated by commas, such as `invariant: NeverOversold`"]);
  expect(modelReport(check)).toMatch(/^Tesota: the header of the model models\/Counter\.tla is not complete:/u);
  const planned = await plannedModels(root, ["models/Copy.tla"]);
  expect(planned.models.map(({ path }) => path)).toEqual(["models/Counter.tla", "models/Racy.tla"]);
  expect(planned.unheaded).toEqual([]);
});

it("sends back a planted fault that is the model's own configuration", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base, "models/Counter.cfg the race")),
    "models/Counter.cfg": config(false) }));
  const check = await checkModel(root, "models/Counter.tla", ["models/Counter.tla"], new AbortController().signal, jar);
  expect(check.problems).toEqual([expect.stringMatching(/^the fault models\/Counter\.cfg is the model itself/u)]);
  expect(check.evidence.outcome).toBe("failed");
});

it("sends back header paths that leave the project, without reading them or running TLC", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base, "../outside.cfg a fault outside")
    .replace("covers: src/counter.ts increment", "covers: ../secret.ts\n   covers: src/counter.ts")), "models/Counter.cfg": config(true) }));
  write(join(root, ".."), { "secret.ts": "not the project's\n" });
  onTestFinished(() => { rmSync(join(root, "..", "secret.ts"), { force: true }); });
  const check = await checkModel(root, "models/Counter.tla", ["models/Counter.tla"], new AbortController().signal, jar);
  expect(check.problems.filter((problem) => problem.includes("outside the project"))).toEqual([
    "../secret.ts is outside the project: covered files and faults are paths from the project root, inside it",
    "../outside.cfg is outside the project: covered files and faults are paths from the project root, inside it"]);
  expect(check.run).toBe("malformed");
  const read = await modelContent(root, "models/Counter.tla", check.header);
  expect(read.find(({ path }) => path === "../secret.ts")?.content).toBeUndefined();
  expect(inProject("src/../../x")).toBe(false);
  expect(inProject("C:/x")).toBe(false);
  expect(inProject("models/./a.cfg")).toBe(true);
});

it("says TLC is missing rather than failing the run", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) }));
  const check = await checkModel(root, "models/Counter.tla", ["src/counter.ts"], new AbortController().signal, join(root, "absent.jar"));
  expect(check.evidence.outcome).toBe("not_started");
  expect(check.evidence.output).toContain("TLC is not installed");
});

it("publishes the model's run and plans its planted fault as operations, the run ending as not started without TLC (#590)", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) }));
  const ops = new GateOperations();
  ops.beginRun("r");
  ops.beginAttempt();
  await checkModel(root, "models/Counter.tla", ["src/counter.ts"], new AbortController().signal, join(root, "absent.jar"), ops);
  const [main, fault] = ops.operations();
  expect(main).toMatchObject({ method: "model_main", state: "ended", result: "not_started", target: expect.stringContaining("models/Counter.tla") });
  expect(fault).toMatchObject({ method: "model_fault", state: "planned", parent: main?.id, target: expect.stringContaining("models/CounterNoLock.cfg") });
  ops.closeAttempt("settled");
  expect(ops.operations()[1]).toMatchObject({ state: "ended", result: "not_started" });
});

it.skipIf(!withTlc)("publishes the main run, each planted fault under it, with TLC's own command (#590)", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) }));
  const ops = new GateOperations();
  ops.beginRun("r");
  ops.beginAttempt();
  await checkModel(root, "models/Counter.tla", ["src/counter.ts"], new AbortController().signal, jar, ops);
  expect(ops.operations().map(({ method, state, result }) => [method, state, result])).toEqual([["model_main", "ended", "passed"],
    ["model_fault", "ended", "failed"]]);
  expect(ops.operations()[0]?.target).toContain("tlc2.TLC");
}, 120_000);

it.skipIf(!withTlc)("model-checks a model whose planted fault breaks its invariant, and says its code may have moved on", async () => {
  const { root, base } = repository((commit) => ({ "models/Counter.tla": spec("Counter", header(commit)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) }));
  write(root, { "src/counter.ts": "export async function increment(): Promise<void> { await Promise.resolve(); }\n" });
  const check = await checkModel(root, "models/Counter.tla", ["src/counter.ts"], new AbortController().signal, jar);
  expect(check.evidence.outcome).toBe("passed");
  expect(check.states).toBe(9);
  expect(check.faults.map(({ verdict }) => verdict)).toEqual(["caught"]);
  expect(check.staleness).toBe("possibly_stale");
  expect(check.stale).toEqual(["src/counter.ts"]);
  expect(check.writtenWithCode).toBe(false);
  expect(check.header.confirmed).toBe(base);
  expect(check.evidence.files).toEqual(["models/Counter.tla", "models/Counter.cfg", "models/CounterNoLock.cfg", "src/counter.ts"]);
}, 120_000);

it.skipIf(!withTlc)("never calls a model stale when the request wrote it with its code and it passed against the code as left", async () => {
  // #555: the model was confirmed against the commit at that point, then the code it covers was fixed in the same request.
  const { root } = repository((commit) => ({ "models/Counter.tla": spec("Counter", header(commit)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) }));
  write(root, { "src/counter.ts": "export async function increment(): Promise<void> { await Promise.resolve(); }\n" });
  const changed = ["models/Counter.tla", "models/Counter.cfg", "models/CounterNoLock.cfg", "src/counter.ts"];
  const check = await checkModel(root, "models/Counter.tla", changed, new AbortController().signal, jar);
  expect(check.evidence.outcome).toBe("passed");
  expect(check.writtenWithCode).toBe(true);
  expect(check.stale).toEqual(["src/counter.ts"]);
  expect(check.staleness).toBe("current");
}, 120_000);

it.skipIf(!withTlc)("sends back a model whose planted fault passes, and one that breaks, with its counterexample", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base, "models/StillLocked.cfg the lock kept")),
    "models/Counter.cfg": config(true), "models/StillLocked.cfg": config(true),
    "models/Racy.tla": spec("Racy", header(base, "models/Counter.cfg the lock kept")), "models/Racy.cfg": config(false) }));
  const weak = await checkModel(root, "models/Counter.tla", ["models/Counter.tla"], new AbortController().signal, jar);
  expect(weak.evidence.outcome).toBe("failed");
  expect(weak.faults.map(({ verdict }) => verdict)).toEqual(["passes"]);
  expect(weak.writtenWithCode).toBe(false);
  expect(modelReport(weak)).toContain("cannot tell them from the code");
  const racy = await checkModel(root, "models/Racy.tla", ["models/Racy.tla", "src/counter.ts"], new AbortController().signal, jar);
  expect(racy.run).toBe("violated");
  expect(racy.writtenWithCode).toBe(true);
  expect(racy.counterexample?.violation).toBe("Invariant NoLostUpdate is violated.");
  expect(racy.counterexample?.steps.map(({ action }) => action)).toEqual(["initial state", "Read", "Read", "Write", "Write"]);
  expect(modelReport(racy)).toMatch(/1\. initial state: .*\n2\. Read: /u);
}, 120_000);

it.skipIf(!withTlc)("captures the nine reached states beside the session from the evidence run", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) }));
  const sessionFile = join(root, "session.jsonl");
  const check = await checkModel(root, "models/Counter.tla", [], new AbortController().signal, jar, undefined, undefined, { sessionFile });
  expect(check.run).toBe("passed");
  expect(check.capture?.status).toBe("captured");
  const manifest = JSON.parse(readFileSync(check.capture?.manifest ?? "", "utf8"));
  expect(manifest.graph.states).toHaveLength(9);
  expect(manifest.exploration).toBe("complete");
  expect(manifest.binding.sessionFile).toBe(sessionFile);
  expect(manifest.binding.tlcVersion).toMatch(/^TLC2 Version/);
  expect(manifest.binding.evidenceHash).toBe(check.evidence.contentHash);
  expect(manifest.graph.states.every((state: { fingerprint: unknown }) => typeof state.fingerprint === "string")).toBe(true);
  for (const extension of ["dot", "mmd", "txt"]) expect(existsSync(join(root, manifest.artifacts[extension].file))).toBe(true);
}, 120_000);

it.skipIf(!withTlc)("labels an early failing exploration and its counts partial", async () => {
  const { root } = repository((base) => ({ "models/Racy.tla": spec("Racy", header(base, "models/Locked.cfg lock kept")),
    "models/Racy.cfg": config(false), "models/Locked.cfg": config(true) }));
  const check = await checkModel(root, "models/Racy.tla", [], new AbortController().signal, jar, undefined, undefined,
    { sessionFile: join(root, "session.jsonl") });
  expect(check.run).toBe("violated");
  expect(check.capture?.status).toBe("captured");
  const manifest = JSON.parse(readFileSync(check.capture?.manifest ?? "", "utf8"));
  expect(manifest.exploration).toBe("partial");
  expect(manifest.counts.kind).toBe("lower_bounds");
  expect(manifest.counts.reached).toBe(check.states);
  expect(manifest.graph.trace).toHaveLength(5);
}, 120_000);

const ring = (base: string): Record<string, string> => ({
  "models/Ring.tla": `${header(base, "models/Fault.cfg same model").replace("invariant: NoLostUpdate", "invariant: Safe, Other")}
---- MODULE Ring ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = (x + 1) % 320
Spec == Init /\\ [][Next]_x
Safe == x < 160
Other == x # 7
====
`,
  "models/Ring.cfg": "SPECIFICATION Spec\n", "models/Fault.cfg": "SPECIFICATION Spec\n",
});

it.skipIf(!withTlc)("keeps the complete 320-state continued exploration but never treats exit zero as a pass", async () => {
  const { root } = repository(ring);
  const check = await checkModel(root, "models/Ring.tla", [], new AbortController().signal, jar, undefined, undefined,
    { sessionFile: join(root, "session.jsonl"), continue: true });
  expect(check.run).toBe("violated");
  expect(check.evidence.outcome).toBe("failed");
  expect(check.capture?.status).toBe("captured");
  const manifest = JSON.parse(readFileSync(check.capture?.manifest ?? "", "utf8"));
  expect(manifest.binding.exitCode).toBe(0);
  expect(manifest.exploration).toBe("complete");
  expect(manifest.counts).toEqual({ kind: "exact", reached: 320, edges: 320, violating: 161 });
  expect(manifest.graph.violations.Safe).toHaveLength(160);
  expect(manifest.graph.violations.Other).toHaveLength(1);
}, 120_000);

it.skipIf(!withTlc)("maps a red initial state from TLC's property report, not the last dumped node", async () => {
  const { root } = repository((base) => ({
    "models/Initial.tla": `${header(base, "models/Fault.cfg bad init").replace("invariant: NoLostUpdate", "invariant: Safe")}
---- MODULE Initial ----
EXTENDS Naturals
VARIABLE x
Init == x \\in {0, 1, 2}
Next == x' = x
Spec == Init /\\ [][Next]_x
Safe == x # 1
====
`, "models/Initial.cfg": "SPECIFICATION Spec\n", "models/Fault.cfg": "SPECIFICATION Spec\n",
  }));
  const check = await checkModel(root, "models/Initial.tla", [], new AbortController().signal, jar, undefined, undefined,
    { sessionFile: join(root, "session.jsonl"), continue: true });
  expect(check.run).toBe("violated");
  expect(check.capture?.status).toBe("captured");
  const manifest = JSON.parse(readFileSync(check.capture?.manifest ?? "", "utf8"));
  const red = manifest.graph.states.filter((state: { fingerprint: string }) => manifest.graph.violations.Safe.includes(state.fingerprint));
  expect(red).toEqual([{ fingerprint: expect.any(String), valuation: "x = 1" }]);
  expect(manifest.graph.states.at(-1).valuation).toBe("x = 2");
}, 120_000);

it.skipIf(!withTlc)("records a bounded capture failure without changing a continued violation verdict", async () => {
  const { root } = repository(ring);
  const check = await checkModel(root, "models/Ring.tla", [], new AbortController().signal, jar, undefined, undefined,
    { sessionFile: join(root, "session.jsonl"), continue: true, limits: { bytes: 128, states: 1, edges: 1 } });
  expect(check.run).toBe("violated");
  expect(check.evidence.outcome).toBe("failed");
  expect(check.capture?.status).toBe("limited");
  const manifest = JSON.parse(readFileSync(check.capture?.manifest ?? "", "utf8"));
  expect(manifest.status).toBe("limited");
  expect(manifest.limits).toEqual({ bytes: 128, states: 1, edges: 1 });
  expect(manifest.binding.evidenceHash).toBe(check.evidence.contentHash);
}, 120_000);

it.skipIf(!withTlc)("marks assertion graph extraction unavailable instead of publishing zero violations", async () => {
  const { root } = repository((base) => ({
    "models/Assertion.tla": `${header(base, "models/Fault.cfg assertion").replace("invariant: NoLostUpdate", "invariant: Safe")}
---- MODULE Assertion ----
EXTENDS Naturals, TLC
VARIABLE x
Init == x = 0
Next == x' = 1 /\\ Assert(x # 1, "unsafe state")
Spec == Init /\\ [][Next]_x
Safe == x >= 0
====
`, "models/Assertion.cfg": "SPECIFICATION Spec\n", "models/Fault.cfg": "SPECIFICATION Spec\n",
  }));
  const check = await checkModel(root, "models/Assertion.tla", [], new AbortController().signal, jar, undefined, undefined,
    { sessionFile: join(root, "session.jsonl") });
  expect(check.evidence.outcome).toBe("failed");
  expect(check.capture?.status).toBe("unavailable");
}, 120_000);

it.skipIf(!withTlc)("keeps a passing verdict when the artifact directory cannot be written", async () => {
  const { root } = repository((base) => ({ "models/Counter.tla": spec("Counter", header(base)), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false), "not-a-directory": "file, not a directory" }));
  const check = await checkModel(root, "models/Counter.tla", [], new AbortController().signal, jar, undefined, undefined,
    { sessionFile: join(root, "not-a-directory", "session.jsonl") });
  expect(check.run).toBe("passed");
  expect(check.evidence.outcome).toBe("passed");
  expect(check.capture?.status).toBe("failed");
  expect(check.faults[0]?.verdict).toBe("caught");
  expect(check.faults[0]?.capture?.status).toBe("failed");
}, 120_000);
