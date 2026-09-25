import { expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CodingSession } from "../src/integrations/pi-coding-session.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";
import type { ExecutionEnvironment, PreparationStep } from "../src/execution-environment.js";
import type { SessionMode } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import { Workspace } from "../src/workspace.js";

const mocks = vi.hoisted(() => ({ openStore: vi.fn() }));
vi.mock("../src/shell-session-store.js", () => ({ openShellSessionStore: mocks.openStore }));

it.each([
  { outcome: "done", expected: "hello" },
  { outcome: "failed", expected: "Tesota context (not written by the user):\nNote: Preparing the sandbox stopped at \"Install dependencies\"; later steps did not run.\ninstall failed\n\nUser request:\nhello" },
] as const)("keeps $outcome preparation distinct from the user request", async ({ outcome, expected }) => {
  const record: ShellSessionRecord = { id: "session", title: "Session 1", engineId: "engine", workspace: null,
    entries: [], inspections: [], interrupted: false, blocked: false };
  const store = { list: () => [record], append: () => {},
    setWorkspace: (_id: string, directory: string) => { record.workspace = directory; },
    allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const preparation = [{ description: "Install dependencies", outcome,
    output: outcome === "failed" ? "install failed" : "" }] as PreparationStep[];
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation,
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const workspace = { directory: "workspace", checkout: "workspace/repo", included: [],
    update: () => ({ status: "current" }), snapshot: () => ({ changes: [] }) } as unknown as Workspace;
  const run = vi.fn(async () => ({ status: "completed" as const, reply: "ok" }));
  const coding = { run, dispose: vi.fn() } as unknown as CodingSession;
  const spies = [
    vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    vi.spyOn(ModelRuntime, "create").mockResolvedValue({ getModel: () => ({}) } as unknown as ModelRuntime),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager),
    vi.spyOn(CodingSession, "create").mockResolvedValue(coding),
  ];
  const mode = { mode: "supervised", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionMode;
  const shell = createProcessTesotaShell("source", "tesota-dark", async () => mode);
  const notices = vi.spyOn(shell.surface, "writeTo");
  try {
    const result = await shell.session("session").work("hello");
    expect(result).toEqual({ status: "completed", changes: [] });
    expect(run).toHaveBeenCalledWith(expected, expect.any(AbortSignal));
    expect(notices).toHaveBeenCalledWith("session", expect.stringContaining("Install dependencies"),
      outcome === "failed" ? "warning" : "info");
  } finally {
    shell.dispose?.();
    for (const spy of spies) spy.mockRestore();
    notices.mockRestore();
  }
});
