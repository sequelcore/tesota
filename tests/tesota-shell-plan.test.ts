import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkingAgent } from "../src/integrations/model-session.js";
import type { AgentActivity } from "../src/integrations/model-session-contract.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import type { SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import type { WorkPlan } from "../src/work-plan.js";
import { Workspace } from "../src/workspace.js";

/**
 * Decision 033 in the shell: the agent's plan is shown beside the prompt and
 * saved with the session, stays out of the conversation as a tool call, and
 * ends with the work it planned.
 */

const mocks = vi.hoisted(() => ({ openStore: vi.fn(), startWorkingAgent: vi.fn(), openModelTarget: vi.fn(),
  planCalls: [] as [string, unknown][] }));
// Every plan the terminal is given, from the moment it is created.
vi.mock("../src/tesota-shell-terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tesota-shell-terminal.js")>();
  return { ...actual, createTesotaShellTerminal: (options: Parameters<typeof actual.createTesotaShellTerminal>[0]) => {
    const terminal = actual.createTesotaShellTerminal(options);
    const show = terminal.setSessionPlan.bind(terminal);
    terminal.setSessionPlan = (id, plan) => { mocks.planCalls.push([id, plan]); show(id, plan); };
    return terminal;
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
  ...await importOriginal<typeof import("../src/execution-providers.js")>(), readSandboxPreference: () => "host" }));

let directory: string;
let record: ShellSessionRecord;
let agentOptions: { plan?: (plan: WorkPlan) => void; onActivity?: (activity: AgentActivity) => void } | undefined;
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tesota-shell-plan-"));
  record = { id: "session", title: "Session 1", engineId: "11111111-1111-4111-8111-111111111111", workspace: null,
    entries: [], inspections: [], interrupted: false, blocked: false,
    retiredEngineIds: [], titleSource: "counter" };
  const store = { list: () => [record], append: vi.fn(),
    setWorkspace: (_id: string, path: string) => { record.workspace = path; },
    setAgentModel: (_id: string, choice: string) => { record.agent = choice; },
    setPlan: vi.fn((_id: string, plan: WorkPlan | undefined) => {
      if (plan === undefined) delete record.plan; else record.plan = [...plan];
    }),
    rotateEngine: vi.fn(() => record.engineId),
    allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const workspace = { directory, checkout: join(directory, "repo"), included: [],
    update: () => ({ status: "current" }), snapshot: () => ({ tree: "t", changes: [] }), revert: vi.fn(), keepRequestsOpen: vi.fn(),
    requests: async () => [], recordRequest: vi.fn(async () => {}) } as unknown as Workspace;
  mocks.openModelTarget.mockResolvedValue({ engine: "pi", model: { id: "codex:gpt-6-luna" } });
  mocks.startWorkingAgent.mockImplementation(async (_access: unknown, options: typeof agentOptions) => {
    agentOptions = options;
    return { usable: true, resumed: true, run: vi.fn(async () => ({ status: "completed", reply: "ok" })),
      switchModel: vi.fn(), dispose: vi.fn(), conversation: vi.fn(async () => []), contextTokens: () => undefined } as unknown as WorkingAgent;
  });
  spies.push(vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
  agentOptions = undefined;
  mocks.planCalls.length = 0;
  rmSync(directory, { recursive: true, force: true });
});

function shell() {
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const created = createProcessTesotaShell("source", "tesota-dark", async () => mode, "session");
  const activity = vi.spyOn(created.surface, "showActivity");
  spies.push(activity);
  return { created, activity };
}

it("shows and saves the agent's plan, keeps its updates out of the conversation, and ends it with the work", async () => {
  const { created, activity } = shell();
  await created.session("session").work("Update the budget.");
  const plan: WorkPlan = [{ step: "Update the totals", status: "in_progress", check: "recalculates with zero errors" }];
  agentOptions?.plan?.(plan);
  expect(mocks.planCalls.at(-1)).toEqual(["session", plan]);
  expect(record.plan).toEqual(plan);
  agentOptions?.onActivity?.({ type: "tool_started", call: "p1", tool: "plan", subject: "" });
  agentOptions?.onActivity?.({ type: "tool_finished", call: "p1", failed: false, output: "Plan updated." });
  agentOptions?.onActivity?.({ type: "tool_started", call: "r1", tool: "read", subject: "budget.csv" });
  expect(activity.mock.calls.map((call) => call[1])).toEqual([{ type: "tool_started", call: "r1", tool: "read", subject: "budget.csv" }]);
  await created.session("session").reject();
  expect(mocks.planCalls.at(-1)).toEqual(["session", undefined]);
  expect(record.plan).toBeUndefined();
  created.dispose?.();
});

it("shows a saved plan again when the shell reopens", () => {
  record.plan = [{ step: "Write the summary", status: "pending" }];
  const { created } = shell();
  expect(mocks.planCalls).toEqual([["session", [{ step: "Write the summary", status: "pending" }]]]);
  created.dispose?.();
});
