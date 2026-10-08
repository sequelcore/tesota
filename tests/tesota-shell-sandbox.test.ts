import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { SourceSession } from "../src/source-session.js";

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
    entries: [], inspections: [], interrupted: false, blocked: false,
    retiredEngineIds: [], titleSource: "counter" };
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
  mocks.openModelTarget.mockResolvedValue({ engine: "pi", model: { id: "chatgpt:gpt-6-luna" } });
  mocks.startWorkingAgent.mockImplementation(async () => {
    const entry = { run: vi.fn(async () => ({ status: "completed" as const, reply: "ok" })), switchModel: vi.fn(async () => {}),
      dispose: vi.fn(), conversation: vi.fn(async () => []), contextTokens: () => 1_000 };
    agents.push(entry);
    return { usable: true, resumed: true, ...entry } as unknown as WorkingAgent;
  });
  spies.push(vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    // A test double stands for the work whether the session works in the source or in a workspace.
    vi.spyOn(SourceSession, "create").mockResolvedValue(workspace as unknown as SourceSession),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function provider(name: string) {
  const environment = { provider: name, guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const prepared: ExecutionProvider = { ...hostProvider, name, prepare: async () => environment };
  return { environment, provider: prepared };
}

function shell(dockerReady = true, wslReady = { now: true }) {
  const wsl = provider("wsl");
  const docker = provider("docker-sandboxes");
  const host = provider("host");
  const chosen = vi.fn(async (preference: SandboxPreference): Promise<SessionExecution> => {
    if (preference === "host") return { commands: "host", provider: host.provider, missing: [] };
    if (preference === "docker") {
      return dockerReady ? { commands: "sandbox", provider: docker.provider }
        : { commands: "host", provider: host.provider, missing: [{ provider: "docker-sandboxes",
          readiness: { ready: false, steps: [{ description: "Install Docker Sandboxes" }] } }] };
    }
    return wslReady.now ? { commands: "sandbox", provider: wsl.provider }
      : { commands: "host", provider: host.provider, missing: [{ provider: "wsl",
        readiness: { ready: false, steps: [{ description: "bubblewrap (bwrap) is not installed" }] } }] };
  });
  const created = createProcessTesotaShell("source", "tesota-dark", chosen, "session");
  const notices = vi.spyOn(created.surface, "writeTo");
  const replies = vi.spyOn(created.surface, "replyTo");
  const label = vi.spyOn(created.surface, "setSessionExecution");
  spies.push(notices, replies, label);
  const said = (): string => [...notices.mock.calls, ...replies.mock.calls].map((call) => call[1]).join("\n");
  /** Only what changed the session is saved with it; a status or a refusal is a reply. */
  const recorded = (): string => notices.mock.calls.map((call) => call[1]).join("\n");
  return { created, chosen, wsl, docker, label, said, recorded };
}

it("switches one session's sandbox, and its agent restarts with the same conversation", async () => {
  const { created, chosen, wsl, docker, label, said, recorded } = shell();
  await created.session("session").work("Add a retry limit.");
  expect(chosen).toHaveBeenLastCalledWith("auto");
  expect(label).toHaveBeenLastCalledWith("session", "›› accept edits on · sandbox · WSL", "sandbox");
  await created.sessionSandbox?.change("session", undefined);
  expect(said()).toContain("Commands in this session run in the WSL sandbox");
  expect(recorded()).not.toContain("Commands in this session run in the WSL sandbox");
  expect(said()).toContain("/sandbox <auto|wsl|docker|host>");
  await created.sessionSandbox?.change("session", "docker");
  expect(wsl.environment.dispose).toHaveBeenCalled();
  expect(agents[0]?.dispose).toHaveBeenCalled();
  expect(record.sandbox).toBe("docker");
  expect(label).toHaveBeenLastCalledWith("session", "›› accept edits on · sandbox · Docker", "sandbox");
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
  const { created, wsl, said } = shell(false);
  await created.session("session").work("Add a retry limit.");
  await created.sessionSandbox?.change("session", "docker");
  expect(said()).toContain("Docker Sandboxes is not ready here: Install Docker Sandboxes");
  expect(said()).toContain("still run in the WSL sandbox");
  expect(wsl.environment.dispose).not.toHaveBeenCalled();
  expect(record.sandbox).toBeUndefined();
  await created.sessionSandbox?.change("session", "vm");
  expect(said()).toContain("Use /sandbox or /sandbox <auto|wsl|docker|host|default>.");
  await created.sessionSandbox?.change("session", "wsl");
  expect(said()).toContain("already run in the WSL sandbox");
  created.dispose?.();
});

it("checks a sandbox again when the operator names it, so one that stopped being ready is not reused", async () => {
  const wslReady = { now: true };
  const { created, said } = shell(true, wslReady);
  await created.session("session").work("Add a retry limit.");
  await created.sessionSandbox?.change("session", "host");
  expect(record.sandbox).toBe("host");
  wslReady.now = false;
  await created.sessionSandbox?.change("session", "wsl");
  expect(said()).toContain("The WSL sandbox is not ready here: bubblewrap (bwrap) is not installed");
  expect(said()).toContain("Commands in this session still run");
  expect(record.sandbox).toBe("host");
  created.dispose?.();
});

/**
 * Decision 048 mid-session: when the agent declares a tool in the repository's toolchain, as `mise.toml`, the next
 * sandboxed command asks the operator first, installs only on their yes, and asks once per declaration.
 */
it("asks before installing a toolchain the repository now declares, once per declaration, and installs only on yes", async () => {
  const { created, wsl, said } = shell();
  const refresh = vi.fn(async () => [{ description: "Install the tools in mise.toml", outcome: "done" as const, output: "" }]);
  Object.assign(wsl.environment, { refreshToolchain: refresh });
  const answers: string[] = ["decline", "install"];
  const asked: string[] = [];
  spies.push(vi.spyOn(created.surface, "chooseIn").mockImplementation(async (_id, question) => {
    asked.push(question.title);
    return answers.shift() as never;
  }));
  await created.session("session").work("Prove the rules.");
  const options = mocks.startWorkingAgent.mock.calls[0]?.[1] as { beforeSandboxCommand?: () => Promise<string | undefined> };
  const before = options.beforeSandboxCommand;
  if (before === undefined) throw new Error("The engine gave the agent no toolchain check");
  // Nothing changed since the sandbox was set up: no question.
  expect(await before()).toBeUndefined();
  // The agent declares Dafny: the operator is asked, declines, and the agent hears so; asking again waits for a new declaration.
  mkdirSync(join(directory, "repo"), { recursive: true });
  writeFileSync(join(directory, "repo", "mise.toml"), '[tools]\n"github:dafny-lang/dafny" = "4.11.0"\n');
  expect(await before()).toContain("declined");
  expect(await before()).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  // Another declaration: asked again; on yes the sandbox sets it up and the agent is told.
  writeFileSync(join(directory, "repo", "mise.toml"), '[tools]\nripgrep = "15.1.0"\n');
  expect(await before()).toContain("now has what the repository's toolchain declares");
  expect(refresh).toHaveBeenCalledOnce();
  expect(asked).toEqual([expect.stringContaining("`mise.toml`"), expect.stringContaining("`mise.toml`")]);
  expect(said()).toContain("Install the tools in mise.toml");
});

it("tells the agent a declared toolchain is unavailable where the sandbox sets up only when prepared, without asking", async () => {
  const { created } = shell();
  const choose = vi.spyOn(created.surface, "chooseIn");
  spies.push(choose);
  await created.session("session").work("Prove the rules.");
  const options = mocks.startWorkingAgent.mock.calls[0]?.[1] as { beforeSandboxCommand?: () => Promise<string | undefined> };
  mkdirSync(join(directory, "repo"), { recursive: true });
  writeFileSync(join(directory, "repo", "mise.toml"), '[tools]\nripgrep = "15.1.0"\n');
  expect(await options.beforeSandboxCommand?.()).toContain("not available in this session");
  expect(choose).not.toHaveBeenCalled();
});
