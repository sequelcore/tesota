import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkingAgent } from "../src/integrations/model-session.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";
import type { ExecutionEnvironment, ExecutionProvider, PrepareOptions } from "../src/execution-environment.js";
import type { SandboxPreference, SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import type { TesotaShellTerminalOptions } from "../src/tesota-shell-terminal.js";
import type { TranscriptEntry } from "../src/tesota-shell-transcript.js";
import { Workspace } from "../src/workspace.js";

/**
 * What a session holds ends with it: an environment still being prepared is
 * stopped when the session closes, switches sandbox or the shell quits, and an
 * environment prepared after a switch stays the session's until it is released.
 */

const mocks = vi.hoisted(() => ({ openStore: vi.fn(), startWorkingAgent: vi.fn(), openModelTarget: vi.fn(), releaseWorkspace: vi.fn(),
  terminal: undefined as TesotaShellTerminalOptions | undefined }));
vi.mock("../src/tesota-shell-terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tesota-shell-terminal.js")>();
  return { ...actual, createTesotaShellTerminal: (options: TesotaShellTerminalOptions) => {
    mocks.terminal = options;
    return actual.createTesotaShellTerminal(options);
  } };
});
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
  ...await importOriginal<typeof import("../src/execution-providers.js")>(), readSandboxPreference: () => "auto",
  releaseWorkspace: mocks.releaseWorkspace }));

let directory: string;
let records: ShellSessionRecord[];
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tesota-shell-resources-"));
  const record = (id: string): ShellSessionRecord => ({ id, title: "Session 1", engineId: "11111111-1111-4111-8111-111111111111",
    workspace: null, entries: [], inspections: [], interrupted: false, blocked: false });
  records = [record("session")];
  const find = (id: string): ShellSessionRecord | undefined => records.find((entry) => entry.id === id);
  const store = { list: () => [...records], append: (id: string, entry: TranscriptEntry) => {
    find(id)?.entries.push(entry);
  },
    create: () => { const created = record("replacement"); records.push(created); return created; },
    remove: (id: string) => { records = records.filter((entry) => entry.id !== id); },
    setWorkspace: (id: string, path: string) => { const found = find(id); if (found !== undefined) found.workspace = path; },
    setAgentModel: (id: string, choice: string) => { const found = find(id); if (found !== undefined) found.agent = choice; },
    setSandbox: (id: string, preference: SandboxPreference | undefined) => {
      const found = find(id);
      if (found === undefined) return;
      if (preference === undefined) delete found.sandbox; else found.sandbox = preference;
    },
    rotateEngine: () => "11111111-1111-4111-8111-111111111111",
    allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const workspace = { directory, checkout: join(directory, "repo"), included: [],
    update: () => ({ status: "current" }), snapshot: () => ({ tree: "t", changes: [] }),
    requests: async () => [], recordRequest: vi.fn(async () => {}) } as unknown as Workspace;
  mocks.openModelTarget.mockResolvedValue({ engine: "pi", model: { id: "codex:gpt-6-luna" } });
  mocks.startWorkingAgent.mockImplementation(async () => ({ usable: true, resumed: true,
    run: vi.fn(async () => ({ status: "completed", reply: "ok" })), switchModel: vi.fn(), dispose: vi.fn(),
    conversation: vi.fn(async () => []), contextTokens: () => undefined }) as unknown as WorkingAgent);
  spies.push(vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
  mocks.terminal = undefined;
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A provider whose preparation finishes only when the test says; one that
 * `stops` rejects as soon as its signal aborts, as the native sandbox does.
 */
function provider(name: string, stops: boolean) {
  const environment = { provider: name, shell: "posix", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const signals: AbortSignal[] = [];
  let fail: (error: Error) => void = () => {};
  const prepare = (_workspace: string, options: PrepareOptions = {}): Promise<ExecutionEnvironment> => {
    if (options.signal !== undefined) signals.push(options.signal);
    return new Promise((_resolve, reject) => {
      fail = reject;
      if (stops) options.signal?.addEventListener("abort", () => { reject(new DOMException("stopped", "AbortError")); }, { once: true });
    });
  };
  return { environment, signals, fail: (error: Error) => { fail(error); },
    provider: { ...hostProvider, name, prepare } satisfies ExecutionProvider };
}

function shell(native: ReturnType<typeof provider>) {
  const docker = { environment: { provider: "docker-sandboxes", shell: "posix", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment };
  const dockerProvider: ExecutionProvider = { ...hostProvider, name: "docker-sandboxes", prepare: async () => docker.environment };
  const created = createProcessTesotaShell("source", "tesota-dark", async (preference: SandboxPreference): Promise<SessionExecution> =>
    preference === "docker" ? { commands: "sandbox", provider: dockerProvider } : { commands: "sandbox", provider: native.provider }, "session");
  const notices = vi.spyOn(created.surface, "writeTo");
  spies.push(notices);
  const said = (): string => notices.mock.calls.map((call) => call[1]).join("\n");
  return { created, docker, said };
}

it("starts a fresh session after saved ones without preparing or retaining an untouched session", async () => {
  const created = createProcessTesotaShell("source", "tesota-dark", async () => { throw new Error("unused"); });
  expect(created.initialSessionId).toBe("replacement");
  expect(mocks.terminal?.initialSession?.id).toBe("session");
  expect(records.map((record) => record.id)).toEqual(["session", "replacement"]);
  created.session("replacement").prepare?.();
  expect(Workspace.create).not.toHaveBeenCalled();
  await created.dispose?.();
  expect(records.map((record) => record.id)).toEqual(["session"]);
});

it("resumes exactly the requested saved session and rejects an unknown id", async () => {
  const created = createProcessTesotaShell("source", "tesota-dark", async () => { throw new Error("unused"); }, "session");
  expect(created.initialSessionId).toBe("session");
  expect(records.map((record) => record.id)).toEqual(["session"]);
  await created.dispose?.();
  expect(() => createProcessTesotaShell("source", "tesota-dark", async () => { throw new Error("unused"); }, "missing"))
    .toThrow("Session missing was not found in this workspace.");
});

it("keeps a new session once it has a request", async () => {
  const created = createProcessTesotaShell("source", "tesota-dark", async () => { throw new Error("unused"); });
  mocks.terminal?.onEntry?.("replacement", { kind: "user", text: "Review this change" });
  await created.dispose?.();
  expect(records.map((record) => record.id)).toEqual(["session", "replacement"]);
});

it("stops a session's preparation when the shell quits, instead of waiting out the release limit", async () => {
  const native = provider("mxc", true);
  const { created, said } = shell(native);
  created.session("session").prepare?.();
  await vi.waitFor(() => { expect(native.signals).toHaveLength(1); });
  const started = Date.now();
  await created.dispose?.();
  expect(native.signals[0]?.aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(said()).not.toContain("could not start");
});

it("stops a closed session's preparation and releases its workspace", async () => {
  const native = provider("mxc", true);
  const { created, said } = shell(native);
  created.session("session").prepare?.();
  await vi.waitFor(() => { expect(native.signals).toHaveLength(1); });
  mocks.terminal?.onCloseSession?.("session");
  await vi.waitFor(() => { expect(records.map((entry) => entry.id)).toEqual(["replacement"]); });
  expect(native.signals[0]?.aborted).toBe(true);
  expect(mocks.releaseWorkspace).toHaveBeenCalledWith(join(directory, "repo"));
  expect(said()).not.toContain("could not start");
  await created.dispose?.();
});

it("keeps the environment prepared after a sandbox switch when the earlier preparation fails late", async () => {
  // This provider settles only when the test says, whatever its signal, as a provider does between steps.
  const native = provider("mxc", false);
  const { created, docker, said } = shell(native);
  created.session("session").prepare?.();
  await vi.waitFor(() => { expect(native.signals).toHaveLength(1); });
  const switching = created.sessionSandbox?.change("session", "docker");
  await vi.waitFor(() => { expect(native.signals[0]?.aborted).toBe(true); });
  // A request while the switch waits for the earlier preparation prepares the new sandbox.
  await expect(created.session("session").work("Add a retry limit.")).resolves.toMatchObject({ status: "completed" });
  native.fail(new Error("the preparation was stopped"));
  await switching;
  await created.dispose?.();
  expect(docker.environment.dispose).toHaveBeenCalledTimes(1);
  expect(said()).not.toContain("could not start");
});
