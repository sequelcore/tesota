import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CodingSession } from "../src/integrations/pi-coding-session.js";
import type { AgentActivity } from "../src/integrations/model-session-contract.js";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import type { SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ReviewInput, ReviewReport, ToolCallRecord, WebEvidence } from "../src/review.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import { SourceSession } from "../src/source-session.js";
import { Workspace } from "../src/workspace.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";

/**
 * The answer check's first pass is a decision Tesota makes for the operator,
 * so its verdict always reaches the conversation with the model that made it
 * and its reason, and an answer it skipped can still be checked in full with
 * /verify; each step names the role and model doing it.
 */

const mocks = vi.hoisted(() => ({ openStore: vi.fn(), firstPass: vi.fn(), reviewAnswer: vi.fn() }));
vi.mock("../src/shell-session-store.js", () => ({ openShellSessionStore: mocks.openStore }));
vi.mock("../src/model-roles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-roles.js")>();
  const { join: joinPath } = await import("node:path");
  const { tmpdir: temporary } = await import("node:os");
  return { ...actual, readModelChoices: () => actual.readModelChoices(joinPath(temporary(), "tesota-test-no-model-choices.json")) };
});
vi.mock("../src/answer-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/answer-check.js")>();
  return { ...actual, firstPass: mocks.firstPass, reviewAnswer: mocks.reviewAnswer };
});

const roots: string[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  mocks.firstPass.mockReset();
  mocks.reviewAnswer.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openShell(record: ShellSessionRecord, run: () => Promise<{ status: "completed"; reply: string }>,
  activity: (listener: (activity: AgentActivity) => void) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "tesota-turns-"));
  roots.push(root);
  const source = join(root, "project");
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: source, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  spawnSync("git", ["init", "--quiet", source]);
  await writeFile(join(source, "price.ts"), "export const price = 1;\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "Fixture");

  mocks.openStore.mockReturnValue({ list: () => [record], append: () => {}, block: () => {}, inspect: () => {},
    setWorkspace: (_id: string, directory: string) => { record.workspace = directory; }, setTitle: () => false,
    setIsolated: () => { record.isolated = true; },
    setAgentModel: () => {}, allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore);
  // The real session and workspace, kept in this test's folders rather than the operator's ~/.tesota.
  const create = SourceSession.create.bind(SourceSession);
  spies.push(vi.spyOn(SourceSession, "create").mockImplementation((directory, _root, options) =>
    create(directory, join(root, "source-sessions"), { ...options, sourcesRoot: join(root, "sources") })));
  const createWorkspace = Workspace.create.bind(Workspace);
  spies.push(vi.spyOn(Workspace, "create").mockImplementation((directory, _root, options) =>
    createWorkspace(directory, join(root, "workspaces"), { ...options, sourcesRoot: join(root, "sources") })));
  spies.push(vi.spyOn(ModelRuntime, "create").mockResolvedValue({ getModel: () => ({}), registerNativeProvider: () => {} } as unknown as ModelRuntime),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager),
    vi.spyOn(CodingSession, "create").mockImplementation(async (options) => {
      if (options.onActivity !== undefined) activity(options.onActivity);
      return { run, dispose: vi.fn(), resumed: false } as unknown as CodingSession;
    }));
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const shell = createProcessTesotaShell(source, "tesota-dark", async () => mode, "session");
  // Records and replies in the order the operator sees them; `replies` holds the ones not saved with the session.
  const notices: string[] = [];
  const replies: string[] = [];
  vi.spyOn(shell.surface, "writeTo").mockImplementation((_id, text) => { notices.push(text); });
  vi.spyOn(shell.surface, "replyTo").mockImplementation((_id, text) => { notices.push(text); replies.push(text); });
  const turns = shell.turnCommands;
  if (turns === undefined) throw new Error("No turn commands");
  return { source, shell, notices, replies, turns };
}

const newRecord = (): ShellSessionRecord => ({ id: "session", title: "Session 1", engineId: "engine", workspace: null,
  entries: [], inspections: [], interrupted: false, blocked: false, retiredEngineIds: [], titleSource: "counter" });



it("shows the first pass's verdict with its model, runs /verify on an answer it skipped, and names who reviewed it", async () => {
  const run = vi.fn(async () => ({ status: "completed" as const, reply: "The total rounds once, after the discount." }));
  const { shell, notices, turns } = await openShell(newRecord(), run);
  const triage = vi.spyOn(shell.surface, "showTriage");
  const progress = vi.spyOn(shell.surface, "reportFor");
  const inspect = vi.spyOn(shell.surface, "inspectFor");
  mocks.firstPass.mockResolvedValue({ decided: true, checkable: false, reason: "it explains a concept and claims nothing about the files" });
  const report: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "The answer holds.", findings: [] };
  mocks.reviewAnswer.mockImplementation(async (_open: unknown, _input: unknown, _signal: unknown,
    onPhase: (activity: string, role: "reviewer" | "refuter") => void) => {
    onPhase("Checking the answer against your requests", "reviewer");
    return [report];
  });
  try {
    const session = shell.session("session");
    expect(await session.work("Why does the total round only at the end?")).toMatchObject({ status: "completed", changes: [] });
    expect(await session.assessAnswer?.()).toMatchObject({ status: "assessed", reviews: [] });
    // The first pass names itself while it decides, and its verdict reaches the conversation.
    expect(progress.mock.calls.some(([, value]) => value.phase === "reviewing" &&
      value.activity === "Deciding whether the answer needs checking · triage chatgpt:gpt-6-luna")).toBe(true);
    expect(triage).toHaveBeenCalledWith("session", { model: "chatgpt:gpt-6-luna", outcome: "skipped",
      reason: "it explains a concept and claims nothing about the files" });
    expect(mocks.reviewAnswer).not.toHaveBeenCalled();

    // The operator asks for the full check anyway; each step names its role and model.
    await turns.verify("session");
    expect(mocks.reviewAnswer).toHaveBeenCalledOnce();
    expect(progress.mock.calls.some(([, value]) => value.phase === "reviewing" &&
      value.activity === "Checking the answer against your requests · reviewer chatgpt:gpt-6-luna")).toBe(true);
    const shown = inspect.mock.calls.at(-1)?.[1];
    expect(shown?.title).toBe("Answer check");
    expect(shown?.summary).toContain("Reviewed by chatgpt:gpt-6-luna.");
    expect(shown?.detail).toContain("First pass\n  triage chatgpt:gpt-6-luna found nothing to check; you asked for the full check with /verify");
    expect(shown?.detail).toContain("  Tesota reviewer · chatgpt:gpt-6-luna\n    The answer holds.");

    // Once checked, there is nothing left to verify.
    await turns.verify("session");
    expect(mocks.reviewAnswer).toHaveBeenCalledOnce();
    expect(notices.at(-1)).toContain("Nothing to verify");
  } finally {
    await shell.dispose?.();
  }
});

it("sends a checkable answer to the full check, says so, and leaves nothing for /verify", async () => {
  const run = vi.fn(async () => ({ status: "completed" as const, reply: "orderTotal rounds once, after the discount." }));
  const { shell, notices, turns } = await openShell(newRecord(), run);
  const triage = vi.spyOn(shell.surface, "showTriage");
  mocks.firstPass.mockResolvedValue({ decided: true, checkable: true, reason: "the reply says how orderTotal rounds" });
  mocks.reviewAnswer.mockResolvedValue([{ reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "Holds.", findings: [] }]);
  try {
    const session = shell.session("session");
    await session.work("How does orderTotal round?");
    await session.assessAnswer?.();
    expect(triage).toHaveBeenCalledWith("session", { model: "chatgpt:gpt-6-luna", outcome: "checked",
      reason: "the reply says how orderTotal rounds" });
    expect(mocks.reviewAnswer).toHaveBeenCalledOnce();
    await turns.verify("session");
    expect(notices.at(-1)).toContain("Nothing to verify");
  } finally {
    await shell.dispose?.();
  }
});

it("checks a research answer against what every round of its request searched and read, so the loop ends (#300)", async () => {
  // The rounds observed on 2026-10-02: pages read first, a search in the correction, a new question afterwards.
  const rounds: (readonly Readonly<{ tool: string; subject: string; evidence: WebEvidence }>[])[] = [
    [{ tool: "web_read", subject: "https://github.com/oven-sh/bun/releases/latest", evidence: { kind: "page",
      url: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2", quotes: ["Bun v1.4.2 Latest Sep 5, 2026"], unfound: 0 } }],
    [{ tool: "web_search", subject: "Bun latest stable release version", evidence: { kind: "search",
      sources: [{ url: "https://bun.sh/blog/bun-v1.4.2", title: "Bun v1.4.2" }] } }],
    [{ tool: "web_search", subject: "Deno latest release", evidence: { kind: "search", sources: [] } }],
  ];
  let listener: ((activity: AgentActivity) => void) | undefined;
  let round = 0;
  const run = vi.fn(async () => {
    for (const [index, call] of (rounds[round] ?? []).entries()) {
      listener?.({ type: "tool_started", call: `r${round}-${index}`, tool: call.tool, subject: call.subject });
      listener?.({ type: "tool_finished", call: `r${round}-${index}`, failed: false, output: "", evidence: call.evidence });
    }
    round += 1;
    return { status: "completed" as const, reply: "Bun v1.4.2, released on 5 September 2026 (GitHub releases, the Bun blog)." };
  });
  const { shell } = await openShell(newRecord(), run, (onActivity) => { listener = onActivity; });
  mocks.firstPass.mockResolvedValue({ decided: true, checkable: true, reason: "the reply states a release and its date" });
  // The reviewer as it behaved then: the answer holds only with both a search and a page reading on record.
  const seen: (readonly ToolCallRecord[])[] = [];
  mocks.reviewAnswer.mockImplementation(async (_open: unknown, input: ReviewInput) => {
    const calls = input.toolCalls ?? [];
    seen.push(calls);
    const searched = calls.some((call) => call.evidence?.kind === "search" && call.evidence.sources.length > 0);
    const read = calls.some((call) => call.evidence?.kind === "page" && call.evidence.quotes.length > 0);
    const status = searched && read ? "met" as const : "unmet" as const;
    return [{ reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: status, findings: [],
      obligations: [{ source: "request", index: 1, obligation: "Name the latest Bun release and its date, with sources",
        status, evidence: searched ? "no page reading is recorded" : "no web search is recorded",
        ...(status === "unmet" ? { disposition: "fixable" as const } : {}) }] } satisfies ReviewReport];
  });
  try {
    const session = shell.session("session");
    const verdict = async (): Promise<string | undefined> => {
      const assessed = await session.assessAnswer?.();
      const report = assessed?.status === "assessed" ? assessed.reviews[0] : undefined;
      return report?.status === "completed" ? report.summary : undefined;
    };
    await session.work("What is the latest stable release of Bun, and on what date was it released? Cite sources.");
    expect(await verdict()).toBe("unmet");
    // The correction searches; the pages the first round read still count, so the second review holds the answer.
    await session.work("Search the web for the release.", "tesota");
    expect(await verdict()).toBe("met");
    expect(seen[1]?.map((call) => call.tool)).toEqual(["web_read", "web_search"]);
    // A new request, once the earlier one held, starts its record over.
    await session.work("And Deno's?");
    await session.assessAnswer?.();
    expect(seen[2]?.map((call) => call.subject)).toEqual(["Deno latest release"]);
  } finally {
    await shell.dispose?.();
  }
});
