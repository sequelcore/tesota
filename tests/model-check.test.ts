import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { checkModel, inProject, modelContent, modelHeader, modelReport, plannedModels, tlcCounterexample, unheadedReport } from "../src/model-check.js";
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
