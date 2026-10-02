import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { parseRunArgs, policyDecisions, type RunOptions, RunOutput, type RunRecord, runInDirectory, runTesotaRun,
  type RunPolicy } from "../src/run-command.js";
import type { SessionEngine, SessionWork } from "../src/session-engine.js";
import { openShellSessionStore } from "../src/shell-session-store.js";
import type { WorkResult } from "../src/tesota-shell.js";
import type { Obligation, ReviewReport } from "../src/review.js";
import type { WorkspaceChange } from "../src/workspace.js";
import type { ApprovedCheck } from "../src/workspace-checks.js";

/**
 * `tesota run` does one request without the shell: every decision is
 * answered by the run's stated policy, the session's work runs through the
 * same loop, and the exit code says how the turn ended.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const policy = (overrides: Partial<RunPolicy> = {}): RunPolicy =>
  ({ commands: false, network: false, checks: "suggested", apply: false, ...overrides });

it("reads the run's flags before its request, and refuses unknown options and an empty request", () => {
  expect(parseRunArgs(["--allow-commands", "--json", "Fix", "the", "--parser"])).toEqual({ request: "Fix the --parser",
    policy: policy({ commands: true }), json: true, folder: false });
  expect(parseRunArgs(["--allow-network", "--apply", "--folder", "--checks=bun run test => reports/unit.xml; bun run lint", "-"]))
    .toEqual({ request: "-", json: false, folder: true, policy: policy({ network: true, apply: true,
      checks: [{ command: "bun run test", reports: ["reports/unit.xml"] }, { command: "bun run lint", reports: [] }] }) });
  expect(parseRunArgs(["--checks=none", "Fix it"])).toMatchObject({ policy: { checks: [] } });
  expect(parseRunArgs(["--yes", "Fix it"])).toContain("Unknown option --yes");
  expect(parseRunArgs(["--json"])).toContain("Give the request");
  expect(parseRunArgs(["--checks=", "Fix it"])).toContain("--checks=none");
});

it("answers its one request and then ends, and every other decision only as its policy allows, for this run only", async () => {
  const closed = policyDecisions("Fix the parser", policy());
  expect(await closed.nextRequest()).toBe("Fix the parser");
  expect(await closed.nextRequest()).toBe("");
  expect(await closed.checks(["bun run check"])).toEqual([{ command: "bun run check", reports: [] }]);
  expect(await closed.checkSecrets([".env"])).toEqual([]);
  expect(await closed.result()).toBe("keep");
  expect(await closed.command({ command: "gh pr list", rule: ["gh", "pr"] })).toBe("deny");
  expect(await closed.network(["example.com:443"])).toBe("deny");
  expect(await closed.site("example.com")).toBe("deny");
  const open = policyDecisions("Fix", policy({ commands: true, network: true, apply: true, checks: [] }));
  // Allowed for this run: a rule is never saved, and a destination is never allowed for the repository.
  expect(await open.command({ command: "gh pr list", rule: ["gh", "pr"] })).toBe("once");
  expect(await open.network(["example.com:443"])).toBe("session");
  expect(await open.site("example.com")).toBe("session");
  expect(await open.result()).toBe("apply");
  expect(await open.checks(["bun run check"])).toEqual([]);
  // Nobody is at the keyboard: suggested checks keep their related form, and the proposed sensitive paths stand.
  const suggested = policyDecisions("Fix", policy());
  expect(await suggested.checks(["bun run check; related: bunx vitest related --run {files}"])).toEqual([{ command: "bun run check",
    reports: [], related: { command: "bunx vitest related --run {files}", reports: [] } }]);
  expect(await suggested.sensitivePaths(["src/egress.ts"])).toEqual(["src/egress.ts"]);
});

const change: WorkspaceChange = { status: "modified", path: "src/parser.ts" };

/** A session's work that completes with `result`, replying through `output` as the agent would. */
function work(output: RunOutput, result: WorkResult, place: "source" | "workspace" = "source"): SessionWork {
  let checks: readonly ApprovedCheck[] | null = null;
  return {
    work: vi.fn(async () => {
      output.showActivity("s", { type: "reply", message: 1, text: "Fixed the parser.", final: true });
      return result;
    }),
    checks: () => checks,
    suggestChecks: () => ["bun run check"],
    setChecks: (approved) => { checks = approved; },
    review: vi.fn(async (approved: readonly ApprovedCheck[]) => ({ status: "ready" as const, tree: "b".repeat(40),
      changes: [change], reviews: [], requests: ["Fix the parser"],
      checks: approved.map(({ command }) => ({ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command,
        tree: "b".repeat(40), environment: "host", guarantees: hostProvider.guarantees, outcome: "passed" as const, exitCode: 0,
        durationMs: 1, output: "" })) })),
    apply: vi.fn(async () => ({ status: "applied" as const, changes: [change] })),
    reject: vi.fn(async () => {}),
    assessAnswer: vi.fn(async () => ({ status: "assessed" as const, reviews: [], requests: ["Fix the parser"] })),
    place: () => place,
  };
}

function run(result: WorkResult, place: "source" | "workspace" = "source", runPolicy: RunPolicy = policy()) {
  const out: string[] = [];
  const err: string[] = [];
  const output = new RunOutput("s", false, (text) => { out.push(text); }, (text) => { err.push(text); });
  const session = work(output, result, place);
  const engine = { session: () => session, dispose: vi.fn(async () => {}) };
  const code = runTesotaRun("s", policyDecisions("Fix the parser", runPolicy), engine, output);
  return { code, session, engine, output, out, err };
}

it("runs its request through the loop, with the suggested checks, and exits 0 when the turn completes", async () => {
  const fixture = run({ status: "completed", changes: [change] });
  await expect(fixture.code).resolves.toBe(0);
  expect(fixture.session.work).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fixture.session.review).mock.calls[0]?.[0]).toEqual([{ command: "bun run check", reports: [] }]);
  // The agent's reply is the run's output; Tesota's notices and progress go to standard error.
  expect(fixture.out.join("")).toBe("Fixed the parser.\n");
  expect(fixture.err.join("")).toContain("This turn stays in your files, undecided");
  expect(fixture.output.record).toMatchObject({ status: "completed", exitCode: 0, reply: "Fixed the parser." });
  expect(fixture.engine.dispose).toHaveBeenCalled();
});

it("applies a result in a copy only when the run says so", async () => {
  const kept = run({ status: "completed", changes: [change] }, "workspace");
  await expect(kept.code).resolves.toBe(0);
  expect(kept.session.apply).not.toHaveBeenCalled();
  const applied = run({ status: "completed", changes: [change] }, "workspace", policy({ apply: true }));
  await expect(applied.code).resolves.toBe(0);
  expect(applied.session.apply).toHaveBeenCalled();
});

it("exits 1 when the request fails, 130 when it is stopped, and 1 when the agent did not stop cleanly", async () => {
  await expect(run({ status: "failed", reason: "the model refused" }).code).resolves.toBe(1);
  await expect(run({ status: "cancelled" }).code).resolves.toBe(130);
  await expect(run({ status: "unsettled" }).code).resolves.toBe(1);
});

it("keeps the run's session to resume, and prints one JSON record of it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-run-"));
  roots.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const options: RunOptions = { request: "Fix the parser", policy: policy(), json: true, folder: false };
  let output: RunOutput | undefined;
  const code = await runInDirectory(root, options, { out: (text) => { out.push(text); }, err: (text) => { err.push(text); } },
    (engineOptions): Pick<SessionEngine, "session" | "dispose" | "interrupt"> => {
      output = engineOptions.output as RunOutput;
      const session = work(output, { status: "completed", changes: [change] });
      return { session: () => session, dispose: async () => {}, interrupt: () => {} };
    }, undefined, join(root, "stores"));
  expect(code).toBe(0);
  const record = JSON.parse(out.join("")) as RunRecord;
  expect(record).toMatchObject({ status: "completed", exitCode: 0, reply: "Fixed the parser.", blocked: false });
  expect(err.at(-1)).toBe(`Session ${record.session}: tesota resume ${record.session} opens it.\n`);
  const store = openShellSessionStore(root, join(root, "stores"));
  try { expect(store.list().map((session) => session.id)).toContain(record.session); } finally { store.close(); }
});

it("keeps the reply of the turn's latest round when the answer check sends the first one back", async () => {
  const out: string[] = [];
  const output = new RunOutput("s", true, (text) => { out.push(text); }, () => {});
  const unmet: Obligation = { source: "request", index: 1, obligation: "one sentence", status: "unmet", evidence: "two", standing: "confirmed" };
  const met: Obligation = { ...unmet, status: "met", evidence: "one" };
  const replies = ["It gives 10%. Above 100.", "It gives 10% above 100."];
  const session: SessionWork = { ...work(output, { status: "completed", changes: [] }),
    work: vi.fn(async () => {
      output.showActivity("s", { type: "reply", message: 1, text: replies.shift() ?? "", final: true });
      return { status: "completed" as const, changes: [] };
    }),
    assessAnswer: vi.fn(async () => ({ status: "assessed" as const, requests: ["What discount?"],
      reviews: [{ reviewer: "Tesota reviewer", tree: "t", status: "completed" as const, summary: "s", findings: [],
        obligations: [replies.length === 1 ? unmet : met] } satisfies ReviewReport] })) };
  const code = await runTesotaRun("s", policyDecisions("What discount?", policy()),
    { session: () => session, dispose: async () => {} }, output);
  expect(code).toBe(0);
  expect(session.work).toHaveBeenCalledTimes(2);
  expect(output.record.reply).toBe("It gives 10% above 100.");
  // With --json, the reply is printed only inside the record.
  expect(out).toEqual([]);
});
