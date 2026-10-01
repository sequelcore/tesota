import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import type { SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import { type CommandApproval, type CommandRequest, workingAgentSetup } from "../src/integrations/pi-coding-session.js";
import { fullAccessQuestion, type SessionDecisions } from "../src/session-decisions.js";
import { createSessionEngine, executionLabel, type SessionOutput } from "../src/session-engine.js";
import { openShellSessionStore, type ShellSessionRecord, type ShellSessionStore } from "../src/shell-session-store.js";
import type { PermissionMode } from "../src/verification/permission-mode.js";

/**
 * Permission modes, switched with Shift+Tab: Read only changes no file and
 * asks before every command, Accept edits keeps the sandbox's and saved
 * rules' answers, and Full access runs every command on this computer without
 * asking. The agent's tools read the mode at each call, so a switch applies at once.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-mode-"));
  roots.push(root);
  return root;
}

function environment(provider: "wsl" | "host"): { environment: ExecutionEnvironment; commands: string[] } {
  const commands: string[] = [];
  const guarantees = provider === "wsl"
    ? { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" } as const : hostProvider.guarantees;
  return { commands, environment: { provider, guarantees, preparation: [],
    run: async (command, options) => { commands.push(command); options.onOutput(Buffer.from(`${provider}\n`)); return { outcome: "exited", exitCode: 0 }; },
    dispose: async () => {} } };
}

async function call(tool: ToolDefinition | undefined, args: Record<string, unknown>): Promise<string> {
  if (tool === undefined) throw new Error("No such tool");
  const result = await tool.execute("c1", args as never, new AbortController().signal, undefined, undefined as never);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

function sandboxedAgent(root: string, mode: () => PermissionMode, rules: readonly (readonly string[])[] = []) {
  const sandbox = environment("wsl");
  const computer = environment("host");
  const requests: CommandRequest[] = [];
  const setup = workingAgentSetup({ cwd: root, environment: sandbox.environment, sandboxed: true, computer: computer.environment,
    mode, commandRules: () => rules, approveCommand: async (request): Promise<CommandApproval> => { requests.push(request); return "once"; } });
  const tool = (name: string): ToolDefinition | undefined => setup.tools.find((candidate) => candidate.name === name);
  return { sandbox: sandbox.commands, computer: computer.commands, requests, tool };
}

it("refuses edits in Read only and allows them again once the mode switches, without restarting the agent", async () => {
  const root = directory();
  let mode: PermissionMode = "read-only";
  const agent = sandboxedAgent(root, () => mode);
  await expect(call(agent.tool("write"), { path: "a.txt", content: "one" })).rejects.toThrow("Read only");
  await expect(call(agent.tool("edit"), { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] })).rejects.toThrow("Read only");
  mode = "accept-edits";
  await call(agent.tool("write"), { path: "a.txt", content: "one" });
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
  // Reading never depends on the mode.
  mode = "read-only";
  expect(await call(agent.tool("read"), { path: "a.txt" })).toContain("one");
});

it("asks before every command in Read only, even in the sandbox and where a saved rule would allow it, and offers no rule", async () => {
  const agent = sandboxedAgent(directory(), () => "read-only", [["git", "status"]]);
  await call(agent.tool("bash"), { command: "ls" });
  await call(agent.tool("run_on_computer"), { command: "git status", reason: "Your Git." });
  expect(agent.requests).toEqual([{ command: "ls" }, { command: "git status", reason: "Your Git." }]);
  expect(agent.sandbox).toEqual(["ls"]);
  expect(agent.computer).toEqual(["git status"]);
});

it("keeps Accept edits as before: the sandbox runs without asking, this computer asks unless a saved rule allows it", async () => {
  const agent = sandboxedAgent(directory(), () => "accept-edits", [["git", "status"]]);
  await call(agent.tool("bash"), { command: "ls" });
  await call(agent.tool("run_on_computer"), { command: "git status", reason: "Your Git." });
  await call(agent.tool("run_on_computer"), { command: "gh pr list", reason: "Your gh." });
  expect(agent.requests).toEqual([{ command: "gh pr list", reason: "Your gh.", rule: ["gh", "pr", "list"] }]);
  expect(agent.sandbox).toEqual(["ls"]);
  expect(agent.computer).toEqual(["git status", "gh pr list"]);
});

it("runs every command on this computer without asking in Full access, the agent's shell included", async () => {
  let mode: PermissionMode = "full-access";
  const agent = sandboxedAgent(directory(), () => mode);
  await call(agent.tool("bash"), { command: "docker ps" });
  await call(agent.tool("run_on_computer"), { command: "gh pr list", reason: "Your gh." });
  expect(agent.requests).toEqual([]);
  expect(agent.computer).toEqual(["docker ps", "gh pr list"]);
  expect(agent.sandbox).toEqual([]);
  // Leaving Full access puts the shell back in the sandbox at once.
  mode = "accept-edits";
  await call(agent.tool("bash"), { command: "ls" });
  expect(agent.sandbox).toEqual(["ls"]);
});

it("runs commands without asking in Full access on a computer with no sandbox", async () => {
  const here = environment("host");
  const approve = vi.fn(async (): Promise<CommandApproval> => "deny");
  const setup = workingAgentSetup({ cwd: directory(), environment: here.environment, sandboxed: false, mode: () => "full-access",
    approveCommand: approve });
  await call(setup.tools.find((tool) => tool.name === "bash"), { command: "rm -rf build" });
  expect(approve).not.toHaveBeenCalled();
  expect(here.commands).toEqual(["rm -rf build"]);
});

it("names the mode and where commands run under the prompt, in the caution color whenever they reach this computer", () => {
  const wsl = { commands: "sandbox", provider: { ...hostProvider, name: "wsl" } } as unknown as SessionExecution;
  const host = { commands: "host", provider: hostProvider, missing: [] } as unknown as SessionExecution;
  expect(executionLabel("accept-edits", wsl)).toEqual({ label: "accept edits · sandbox · WSL", place: "sandbox" });
  expect(executionLabel("read-only", wsl)).toEqual({ label: "read only · sandbox · WSL", place: "sandbox" });
  expect(executionLabel("full-access", wsl)).toEqual({ label: "full access · this computer", place: "host" });
  expect(executionLabel("accept-edits", host)).toEqual({ label: "accept edits · this computer · asks first", place: "host" });
  expect(executionLabel("full-access", host)).toEqual({ label: "full access · this computer", place: "host" });
  // Before the session's environment is chosen, the mode alone.
  expect(executionLabel("read-only", undefined)).toEqual({ label: "read only", place: "sandbox" });
  expect(executionLabel("full-access", undefined)).toEqual({ label: "full access · this computer", place: "host" });
});

it("starts new sessions in the mode last chosen in the repository, while each saved session keeps its own", () => {
  const root = directory();
  const source = join(root, "repository");
  const store = openShellSessionStore(source, root);
  const first = store.create();
  expect(store.lastMode()).toBe("accept-edits");
  expect(first.mode).toBe("accept-edits");
  store.setMode(first.id, "read-only");
  const second = store.create();
  expect(second.mode).toBe("read-only");
  store.setMode(second.id, "full-access");
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.lastMode()).toBe("full-access");
  expect(reopened.list().map((session) => session.mode)).toEqual(["read-only", "full-access"]);
  reopened.close();
});

it("reads sessions saved before modes existed as accept edits", () => {
  const root = directory();
  const source = join(root, "repository");
  const store = openShellSessionStore(source, root);
  store.create();
  store.close();
  const [file] = readdirSync(root).filter((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("No store file");
  const saved = JSON.parse(readFileSync(join(root, file), "utf8")) as { mode?: string; sessions: { mode?: string }[] };
  delete saved.mode;
  for (const session of saved.sessions) delete session.mode;
  writeFileSync(join(root, file), JSON.stringify(saved));
  const reopened = openShellSessionStore(source, root);
  expect(reopened.lastMode()).toBe("accept-edits");
  expect(reopened.list()[0]?.mode).toBeUndefined();
  reopened.close();
});

function modeEngine(fullAccess: () => Promise<boolean>, mode: PermissionMode = "accept-edits") {
  const record: ShellSessionRecord = { id: "s", title: "Session 1", engineId: "e", workspace: null, entries: [], inspections: [],
    interrupted: false, blocked: false, retiredEngineIds: [], mode, titleSource: "counter" };
  const store = { list: () => [record], setMode: (_id: string, mode: PermissionMode) => { record.mode = mode; } } as unknown as ShellSessionStore;
  const labels: string[] = [];
  const notices: string[] = [];
  const output = new Proxy({}, { get: (_target, name) => name === "setSessionExecution"
    ? (_id: string, label: string) => { labels.push(label); }
    : name === "writeTo" || name === "replyTo" ? (_id: string, text: string) => { notices.push(text); } : () => undefined }) as SessionOutput;
  const decisions = { fullAccess } as unknown as SessionDecisions;
  const engine = createSessionEngine({ cwd: directory(), store, output, decisions: () => decisions,
    chooseExecution: async () => { throw new Error("not used"); }, fresh: new Set(), mode: () => record.mode ?? "accept-edits" });
  return { engine, record, labels, notices };
}

it("cycles accept edits, full access, read only with Shift+Tab, asking once per session before Full access", async () => {
  const fullAccess = vi.fn(async () => true);
  const { engine, record, labels, notices } = modeEngine(fullAccess);
  await engine.permissionMode.cycle("s");
  expect(record.mode).toBe("full-access");
  await engine.permissionMode.cycle("s");
  expect(record.mode).toBe("read-only");
  await engine.permissionMode.cycle("s");
  await engine.permissionMode.cycle("s");
  expect(record.mode).toBe("full-access");
  expect(fullAccess).toHaveBeenCalledOnce();
  expect(labels).toEqual(["full access · this computer", "read only", "accept edits", "full access · this computer"]);
  // The question's answer recorded the first entry; entering again without a question still leaves a line.
  expect(notices).toEqual(["Full access: commands run on this computer without asking."]);
  await engine.dispose();
});

it("stays in the current mode when the operator declines Full access", async () => {
  const { engine, record, labels } = modeEngine(async () => false);
  await engine.permissionMode.cycle("s");
  expect(record.mode).toBe("accept-edits");
  expect(labels).toEqual([]);
  await engine.dispose();
});

it("reminds the operator when a session opens in Full access, and says nothing otherwise", async () => {
  const full = modeEngine(async () => true, "full-access");
  full.engine.permissionMode.open("s");
  expect(full.labels).toEqual(["full access · this computer"]);
  expect(full.notices).toEqual([expect.stringContaining("This session is in Full access")]);
  await full.engine.dispose();
  const accept = modeEngine(async () => true);
  accept.engine.permissionMode.open("s");
  expect(accept.notices).toEqual([]);
  await accept.engine.dispose();
});

it("counts each command Full access let run without asking, and none that asked or ran in another mode", async () => {
  let mode: PermissionMode = "full-access";
  const counted = vi.fn();
  const sandbox = environment("wsl");
  const setup = workingAgentSetup({ cwd: directory(), environment: sandbox.environment, sandboxed: true,
    computer: environment("host").environment, mode: () => mode, onFullAccessCommand: counted,
    approveCommand: async (): Promise<CommandApproval> => "once" });
  const bash = setup.tools.find((tool) => tool.name === "bash");
  await call(bash, { command: "docker ps" });
  await call(bash, { command: "gh pr list" });
  mode = "accept-edits";
  await call(bash, { command: "ls" });
  mode = "read-only";
  await call(bash, { command: "ls" });
  expect(counted).toHaveBeenCalledTimes(2);
});

it("asks before Full access as Codex does: the risk in the warning color, and Enter cancels", () => {
  expect(fullAccessQuestion.title).toBe("Enable Full access?");
  expect(fullAccessQuestion.caution).toContain("risk of data loss");
  expect(fullAccessQuestion.detail).toContain(".env");
  expect(fullAccessQuestion.initial).toBe("deny");
  expect(fullAccessQuestion.options.map((option) => option.label)).toEqual(["Yes, continue anyway", "Cancel"]);
});
