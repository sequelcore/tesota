import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkingAgent } from "../src/integrations/model-session.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import type { SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import { Workspace } from "../src/workspace.js";

/**
 * Decision 026 in the shell: `/model` switches the agent in place on the same
 * engine, and on another engine, like `/handoff`, starts a new conversation
 * that receives Tesota's brief with the next request, never silently.
 */

const mocks = vi.hoisted(() => ({ openStore: vi.fn(), startWorkingAgent: vi.fn(), openModelTarget: vi.fn(),
  choices: {} as Record<string, string>, consultAdvisor: vi.fn() }));
vi.mock("../src/integrations/advisor-session.js", () => ({ consultAdvisor: mocks.consultAdvisor }));
vi.mock("../src/shell-session-store.js", () => ({ openShellSessionStore: mocks.openStore }));
vi.mock("../src/integrations/model-session.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/integrations/model-session.js")>(),
  startWorkingAgent: mocks.startWorkingAgent, openModelTarget: mocks.openModelTarget }));
// The shell must not read the operator's own choices in ~/.tesota: the agent's role takes its default, codex:gpt-6-luna.
vi.mock("../src/model-roles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-roles.js")>();
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  return { ...actual, readModelChoices: () => ({ ...actual.readModelChoices(join(tmpdir(), "tesota-test-no-model-choices.json")),
    ...mocks.choices }) };
});

let directory: string;
let record: ShellSessionRecord;
let agents: { agent: WorkingAgent; run: ReturnType<typeof vi.fn>; switchModel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn> }[];
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tesota-shell-model-"));
  record = { id: "session", title: "Session 1", engineId: "11111111-1111-4111-8111-111111111111", workspace: null,
    entries: [{ kind: "agent", text: "I added the limit." }], inspections: [], interrupted: false, blocked: false };
  let rotation = 0;
  const store = { list: () => [record], append: () => {},
    setWorkspace: (_id: string, path: string) => { record.workspace = path; },
    setAgentModel: vi.fn((_id: string, choice: string) => { record.agent = choice; }),
    rotateEngine: vi.fn(() => {
      record.retiredEngineIds = [...record.retiredEngineIds ?? [], record.engineId];
      record.engineId = `22222222-2222-4222-8222-22222222222${rotation++}`;
      return record.engineId;
    }),
    allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore;
  mocks.openStore.mockReturnValue(store);
  const workspace = { directory, checkout: join(directory, "repo"), included: [],
    update: () => ({ status: "current" }), snapshot: () => ({ tree: "t", changes: [{ status: "modified", path: "src/retry.ts" }] }),
    requests: async () => ["Add a retry limit."], recordRequest: vi.fn(async () => {}) } as unknown as Workspace;
  agents = [];
  mocks.openModelTarget.mockImplementation(async (choice: string) => choice.startsWith("claude-code:")
    ? { engine: "claude-code", model: choice.slice("claude-code:".length) } : { engine: "pi", model: { id: choice } });
  mocks.startWorkingAgent.mockImplementation(async () => {
    const entry = { run: vi.fn(async () => ({ status: "completed" as const, reply: "ok" })), switchModel: vi.fn(async () => {}),
      dispose: vi.fn(), conversation: vi.fn(async () => [{ role: "user", text: "Add a retry limit." }]),
      contextTokens: () => 48_300 };
    agents.push({ ...entry, agent: { usable: true, resumed: false, ...entry } as unknown as WorkingAgent });
    return agents.at(-1)?.agent;
  });
  spies.push(vi.spyOn(Workspace, "create").mockResolvedValue(workspace),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager));
});

afterEach(() => {
  for (const key of Object.keys(mocks.choices)) delete mocks.choices[key];
  for (const spy of spies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function shell() {
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const created = createProcessTesotaShell("source", "tesota-dark", async () => mode);
  const notices = vi.spyOn(created.surface, "writeTo");
  const model = vi.spyOn(created.surface, "setSessionModel");
  spies.push(notices, model);
  const said = (): string => notices.mock.calls.map((call) => call[1]).join("\n");
  return { created, notices, model, said };
}

it("switches in place on the same engine, and the conversation continues", async () => {
  const { created, said, model } = shell();
  await created.session("session").work("Add a retry limit.");
  await created.agentModel?.change("session", "codex:gpt-6-sol");
  expect(agents[0]?.switchModel).toHaveBeenCalledWith(expect.objectContaining({ engine: "pi" }));
  expect(record.agent).toBe("codex:gpt-6-sol");
  expect(record.engineId).toBe("11111111-1111-4111-8111-111111111111");
  expect(model).toHaveBeenLastCalledWith("session", "codex:gpt-6-sol");
  expect(said()).toContain("its conversation continues");
  // Caches belong to one model and level: the operator learns what the next request re-reads, and the cheaper way.
  expect(said()).toContain("The next request re-reads this conversation, about 48k tokens, without the prompt cache");
  expect(said()).toContain("/handoff");
  // Every other role takes its default, Luna: the new agent is no longer judged by its own model.
  expect(said()).not.toContain("Same model judging");
  // A lab shared with its judges is a note, dimmed; the same model is a warning, colored.
  expect(vi.mocked(created.surface.writeTo)).toHaveBeenCalledWith("session", expect.stringContaining("Same lab"), "info");
  await created.agentModel?.change("session", "codex:gpt-6-luna");
  expect(said()).toContain("the reviewer judges the agent's work, and both use codex:gpt-6-luna");
  await created.session("session").work("Also log it.");
  expect(mocks.startWorkingAgent).toHaveBeenCalledTimes(1);
  created.dispose?.();
});

it("starts a new conversation on another engine, says so, and sends the brief with the next request", async () => {
  const { created, said } = shell();
  await created.session("session").work("Add a retry limit.");
  await created.agentModel?.change("session", "claude-code:opus");
  expect(agents[0]?.dispose).toHaveBeenCalled();
  expect(agents[0]?.switchModel).not.toHaveBeenCalled();
  expect(record.retiredEngineIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  expect(said()).toContain("will not have this conversation");
  await created.session("session").work("Now log each retry.");
  expect(mocks.startWorkingAgent).toHaveBeenLastCalledWith({ target: { engine: "claude-code", model: "opus" } },
    expect.anything(), expect.objectContaining({ conversationId: record.engineId }));
  const prompt = String(agents[1]?.run.mock.calls[0]?.[0]);
  expect(prompt).toContain("Tesota handoff (not written by the user)");
  expect(prompt).toContain("1. Add a retry limit.");
  expect(prompt).toContain("  edit src/retry.ts");
  expect(prompt).toContain("I added the limit.");
  expect(prompt.endsWith("User request:\nNow log each retry.")).toBe(true);
  expect(said()).toContain("Tesota sends it this brief");
  created.dispose?.();
});

it("hands off on the same model with /handoff", async () => {
  const { created, said } = shell();
  await created.session("session").work("Add a retry limit.");
  await created.agentModel?.handOff("session");
  expect(agents[0]?.dispose).toHaveBeenCalled();
  expect(record.agent).toBe("codex:gpt-6-luna");
  expect(record.engineId).not.toBe("11111111-1111-4111-8111-111111111111");
  expect(said()).toContain("will not have this conversation");
  created.dispose?.();
});

it("gives the agent an advisor only when the role is on, reading the agent's conversation on the advisor's model", async () => {
  const off = shell();
  await off.created.session("session").work("Add a retry limit.");
  expect(mocks.startWorkingAgent.mock.calls[0]?.[1]).not.toHaveProperty("advisor");
  off.created.dispose?.();
  mocks.choices["advisor"] = "claude-code:opus";
  record.agent = undefined;
  const on = shell();
  await on.created.session("session").work("Add a retry limit.");
  const options = mocks.startWorkingAgent.mock.calls[1]?.[1] as
    { advisor?: { consult(q: string | undefined, s: AbortSignal): Promise<unknown> } } | undefined;
  const advisor = options?.advisor;
  expect(advisor).toBeDefined();
  mocks.consultAdvisor.mockResolvedValue({ status: "answered", answer: "Check the caller." });
  expect(await advisor?.consult("Where should the counter live?", new AbortController().signal))
    .toMatchObject({ result: { status: "answered", answer: "Check the caller." } });
  expect(mocks.consultAdvisor).toHaveBeenCalledWith(expect.objectContaining({ target: { engine: "claude-code", model: "opus" } }),
    [{ role: "user", text: "Add a retry limit." }], "Where should the counter live?", expect.any(AbortSignal));
  on.created.dispose?.();
});

it("refuses a model no route offers and changes nothing", async () => {
  const { created, notices } = shell();
  await created.agentModel?.change("session", "codex:no-such-model");
  expect(notices).toHaveBeenLastCalledWith("session", expect.stringContaining("is not offered"), "warning");
  expect(record.agent).toBeUndefined();
  await created.agentModel?.change("session", "codex:gpt-6-luna");
  expect(notices).toHaveBeenLastCalledWith("session", expect.stringContaining("already uses codex:gpt-6-luna"));
  // A reasoning level the model accepts is a switch on the same engine; one it does not is refused.
  await created.agentModel?.change("session", "codex:gpt-6-luna@high");
  expect(record.agent).toBe("codex:gpt-6-luna@high");
  await created.agentModel?.change("session", "claude-code:haiku@high");
  expect(notices).toHaveBeenLastCalledWith("session", expect.stringContaining("is not offered"), "warning");
  created.dispose?.();
});
