import { expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CodingSession } from "../src/integrations/pi-coding-session.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";
import type { ExecutionEnvironment, PreparationStep } from "../src/execution-environment.js";
import type { SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import { Workspace } from "../src/workspace.js";
import { SourceSession } from "../src/source-session.js";

const mocks = vi.hoisted(() => ({ openStore: vi.fn() }));
vi.mock("../src/shell-session-store.js", () => ({ openShellSessionStore: mocks.openStore }));
// The shell must not read the operator's own choices in ~/.tesota: every role takes its default, the Pi engine mocked here.
vi.mock("../src/model-roles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-roles.js")>();
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  return { ...actual, readModelChoices: () => actual.readModelChoices(join(tmpdir(), "tesota-test-no-model-choices.json")) };
});

it("brings the operator's newer repository state to their request, never to a correction round", async () => {
  const record: ShellSessionRecord = { id: "session", title: "Session 1", engineId: "engine", workspace: null,
    entries: [], inspections: [], interrupted: false, blocked: false,
    retiredEngineIds: [], titleSource: "counter" };
  const store = { list: () => [record], append: () => {},
    setWorkspace: (_id: string, directory: string) => { record.workspace = directory; },
    setAgentModel: () => {}, allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const update = vi.fn(async () => ({ status: "updated" as const, changes: [{ status: "modified" as const, path: "src/cli.ts" }] }));
  const workspace = { directory: "workspace", checkout: "workspace/repo", included: [], update,
    snapshot: () => ({ tree: "t", changes: [] }), requests: async () => [], recordRequest: vi.fn(async () => {}) } as unknown as Workspace;
  const run = vi.fn(async () => ({ status: "completed" as const, reply: "ok" }));
  const coding = { run, dispose: vi.fn(), resumed: false } as unknown as CodingSession;
  const spies = [
    vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    // A test double stands for the work whether the session works in the source or in a workspace.
    vi.spyOn(SourceSession, "create").mockResolvedValue(workspace as unknown as SourceSession),
    vi.spyOn(ModelRuntime, "create").mockResolvedValue({ getModel: () => ({}) } as unknown as ModelRuntime),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager),
    vi.spyOn(CodingSession, "create").mockResolvedValue(coding),
  ];
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const shell = createProcessTesotaShell("source", "tesota-dark", async () => mode, "session");
  try {
    await shell.session("session").work("Fix the retry limit");
    expect(run).toHaveBeenLastCalledWith(expect.stringContaining("the workspace now includes them:\n  modified src/cli.ts"),
      expect.any(AbortSignal));
    // A correction's review compares it with the round before; the operator's edits must not appear in it as the agent's.
    await shell.session("session").work("Tesota review of your changes", "tesota");
    expect(update).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith("Tesota review of your changes", expect.any(AbortSignal));
  } finally {
    shell.dispose?.();
    for (const spy of spies) spy.mockRestore();
  }
});

it.each([
  { outcome: "done", expected: "hello" },
  { outcome: "failed", expected: "Tesota context (not written by the user):\nNote: Preparing the sandbox stopped at \"Install dependencies\"; later steps did not run.\ninstall failed\n\nUser request:\nhello" },
] as const)("keeps $outcome preparation distinct from the user request", async ({ outcome, expected }) => {
  const record: ShellSessionRecord = { id: "session", title: "Session 1", engineId: "engine", workspace: null,
    entries: [], inspections: [], interrupted: false, blocked: false,
    retiredEngineIds: [], titleSource: "counter" };
  const store = { list: () => [record], append: () => {},
    setWorkspace: (_id: string, directory: string) => { record.workspace = directory; },
    setAgentModel: () => {}, allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const preparation = [{ description: "Install dependencies", outcome,
    output: outcome === "failed" ? "install failed" : "" }] as PreparationStep[];
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation,
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const recordRequest = vi.fn(async () => {});
  const workspace = { directory: "workspace", checkout: "workspace/repo", included: [],
    update: () => ({ status: "current" }), snapshot: () => ({ tree: "t", changes: [] }), requests: async () => [], recordRequest } as unknown as Workspace;
  const run = vi.fn(async () => ({ status: "completed" as const, reply: "ok" }));
  const coding = { run, dispose: vi.fn(), resumed: false } as unknown as CodingSession;
  const spies = [
    vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    // A test double stands for the work whether the session works in the source or in a workspace.
    vi.spyOn(SourceSession, "create").mockResolvedValue(workspace as unknown as SourceSession),
    vi.spyOn(ModelRuntime, "create").mockResolvedValue({ getModel: () => ({}) } as unknown as ModelRuntime),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager),
    vi.spyOn(CodingSession, "create").mockResolvedValue(coding),
  ];
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const shell = createProcessTesotaShell("source", "tesota-dark", async () => mode, "session");
  const notices = vi.spyOn(shell.surface, "writeTo");
  try {
    const result = await shell.session("session").work("hello");
    expect(result).toEqual({ status: "completed", changes: [] });
    expect(run).toHaveBeenCalledWith(expected, expect.any(AbortSignal));
    // The request record keeps the operator's words only, never Tesota's added context.
    expect(recordRequest).toHaveBeenCalledWith("hello");
    expect(notices).toHaveBeenCalledWith("session", expect.stringContaining("Install dependencies"),
      outcome === "failed" ? "warning" : "info");
  } finally {
    shell.dispose?.();
    for (const spy of spies) spy.mockRestore();
    notices.mockRestore();
  }
});
