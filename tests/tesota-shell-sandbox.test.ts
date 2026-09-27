import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkingAgent } from "../src/integrations/model-session.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";
import type { ExecutionEnvironment, ExecutionProvider } from "../src/execution-environment.js";
import type { SandboxPreference, SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import { Workspace } from "../src/workspace.js";

/**
 * Decision 030 in the shell: `/sandbox` chooses where one session's commands
 * run. The session's environment is prepared again and its agent restarts
 * with the same conversation, now with the new environment's tools.
 */

const mocks = vi.hoisted(() => ({ openStore: vi.fn(), startWorkingAgent: vi.fn(), openModelTarget: vi.fn() }));
vi.mock("../src/shell-session-store.js", () => ({ openShellSessionStore: mocks.openStore }));
vi.mock("../src/integrations/model-session.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/integrations/model-session.js")>(),
  startWorkingAgent: mocks.startWorkingAgent, openModelTarget: mocks.openModelTarget }));
vi.mock("../src/model-roles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-roles.js")>();
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  return { ...actual, readModelChoices: () => actual.readModelChoices(join(tmpdir(), "tesota-test-no-model-choices.json")) };
});
vi.mock("../src/execution-providers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/execution-providers.js")>(), readSandboxPreference: () => "auto" }));

let directory: string;
let record: ShellSessionRecord;
let agents: { run: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[];
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tesota-shell-sandbox-"));
  record = { id: "session", title: "Session 1", engineId: "11111111-1111-4111-8111-111111111111", workspace: null,
    entries: [], inspections: [], interrupted: false, blocked: false };
  const store = { list: () => [record], append: () => {},
    setWorkspace: (_id: string, path: string) => { record.workspace = path; },
    setAgentModel: (_id: string, choice: string) => { record.agent = choice; },
    setSandbox: vi.fn((_id: string, preference: SandboxPreference | undefined) => {
      if (preference === undefined) delete record.sandbox; else record.sandbox = preference;
    }),
    rotateEngine: vi.fn(() => record.engineId),
    allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const workspace = { directory, checkout: join(directory, "repo"), included: [],
    update: () => ({ status: "current" }), snapshot: () => ({ tree: "t", changes: [] }),
    requests: async () => [], recordRequest: vi.fn(async () => {}) } as unknown as Workspace;
  agents = [];
  mocks.openModelTarget.mockResolvedValue({ engine: "pi", model: { id: "codex:gpt-6-luna" } });
  mocks.startWorkingAgent.mockImplementation(async () => {
    const entry = { run: vi.fn(async () => ({ status: "completed" as const, reply: "ok" })), switchModel: vi.fn(async () => {}),
      dispose: vi.fn(), conversation: vi.fn(async () => []), contextTokens: () => 1_000 };
    agents.push(entry);
    return { usable: true, resumed: true, ...entry } as unknown as WorkingAgent;
  });
  spies.push(vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function provider(name: string, shell: "posix" | "powershell") {
  const environment = { provider: name, shell, guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const prepared: ExecutionProvider = { ...hostProvider, name, prepare: async () => environment };
  return { environment, provider: prepared };
}

function shell(dockerReady = true) {
  const native = provider("mxc", "powershell");
  const docker = provider("docker-sandboxes", "posix");
  const host = provider("host", "posix");
  const chosen = vi.fn(async (preference: SandboxPreference): Promise<SessionExecution> => {
    if (preference === "host") return { commands: "host", provider: host.provider, missing: [] };
    if (preference === "docker") {
      return dockerReady ? { commands: "sandbox", provider: docker.provider }
        : { commands: "host", provider: host.provider, missing: [{ provider: "docker-sandboxes",
          readiness: { ready: false, steps: [{ description: "Install Docker Sandboxes" }] } }] };
    }
    return { commands: "sandbox", provider: native.provider };
  });
  const created = createProcessTesotaShell("source", "tesota-dark", chosen);
  const notices = vi.spyOn(created.surface, "writeTo");
  const label = vi.spyOn(created.surface, "setSessionExecution");
  spies.push(notices, label);
  const said = (): string => notices.mock.calls.map((call) => call[1]).join("\n");
  return { created, chosen, native, docker, label, said };
}

it("switches one session's sandbox, and its agent restarts with the same conversation", async () => {
  const { created, chosen, native, docker, label, said } = shell();
  await created.session("session").work("Add a retry limit.");
  expect(chosen).toHaveBeenLastCalledWith("auto");
  expect(label).toHaveBeenLastCalledWith("session", "sandbox · native");
  await created.sessionSandbox?.change("session", undefined);
  expect(said()).toContain("Commands in this session run in the native sandbox");
  expect(said()).toContain("/sandbox <auto|native|docker|host>");
  await created.sessionSandbox?.change("session", "docker");
  expect(native.environment.dispose).toHaveBeenCalled();
  expect(agents[0]?.dispose).toHaveBeenCalled();
  expect(record.sandbox).toBe("docker");
  expect(label).toHaveBeenLastCalledWith("session", "sandbox · Docker");
  expect(said()).toContain("Commands in this session now run in Docker Sandboxes");
  expect(said()).toContain("its conversation continues");
  await created.session("session").work("Now log each retry.");
  // The same conversation, in the new environment: nothing was rotated, and the agent is told where commands run now.
  expect(record.engineId).toBe("11111111-1111-4111-8111-111111111111");
  expect(mocks.startWorkingAgent).toHaveBeenLastCalledWith(expect.anything(),
    expect.objectContaining({ environment: docker.environment }),
    expect.objectContaining({ conversationId: "11111111-1111-4111-8111-111111111111" }));
  expect(String(agents[1]?.run.mock.calls[0]?.[0])).toContain("Commands now run in Docker Sandboxes");
  await created.sessionSandbox?.change("session", "default");
  expect(record.sandbox).toBeUndefined();
  expect(said()).toContain("follows your choice for new sessions");
  created.dispose?.();
});

it("keeps the session's sandbox when the chosen one is not ready, and refuses an unknown one", async () => {
  const { created, native, said } = shell(false);
  await created.session("session").work("Add a retry limit.");
  await created.sessionSandbox?.change("session", "docker");
  expect(said()).toContain("Docker Sandboxes is not ready here: Install Docker Sandboxes");
  expect(said()).toContain("still run in the native sandbox");
  expect(native.environment.dispose).not.toHaveBeenCalled();
  expect(record.sandbox).toBeUndefined();
  await created.sessionSandbox?.change("session", "vm");
  expect(said()).toContain("Use /sandbox or /sandbox <auto|native|docker|host|default>.");
  await created.sessionSandbox?.change("session", "native");
  expect(said()).toContain("already run in the native sandbox");
  created.dispose?.();
});
