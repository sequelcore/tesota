import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import { hostProvider } from "../src/host-environment.js";
import { type CommandApproval, type CommandRequest, workingAgentSetup } from "../src/integrations/pi-coding-session.js";

/**
 * The agent's shell (decision 030): bash wherever its commands run, running
 * without asking in a sandbox, and told where the workspace appears to its
 * commands when that is not its own path, as under `/mnt` in the WSL sandbox.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-shell-tool-"));
  roots.push(root);
  return root;
}

function sandbox(): { environment: ExecutionEnvironment; commands: string[] } {
  const commands: string[] = [];
  return { commands, environment: { provider: "wsl", commandRoot: "/mnt/c/workspace",
    guarantees: { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" }, preparation: [],
    run: async (command, options) => { commands.push(command); options.onOutput(Buffer.from("sandboxed\n")); return { outcome: "exited", exitCode: 0 }; },
    dispose: async () => {} } };
}

/** A tool call's text; a call that failed rejects, whether the tool threw or returned an error result, as Pi's bash does. */
async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("c1", args as never, new AbortController().signal, undefined, undefined as never);
  const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
  if (result.isError === true) throw new Error(text);
  return text;
}

it("runs the agent's bash commands in the sandbox without asking, and says where the workspace appears to them", async () => {
  const root = workspace();
  const { environment, commands } = sandbox();
  const approve = vi.fn(async (): Promise<CommandApproval> => "deny");
  const setup = workingAgentSetup({ cwd: root, environment, sandboxed: true, approveCommand: approve });
  expect(setup.tools.map((tool) => tool.name)).not.toContain("run_on_computer");
  expect(setup.tools.map((tool) => tool.name)).toContain("bash");
  expect(setup.systemPrompt).toContain("In commands the workspace is /mnt/c/workspace; the file tools keep its real path.");
  const bash = setup.tools.find((tool) => tool.name === "bash");
  if (bash === undefined) throw new Error("No bash tool");
  expect(await call(bash, { command: "ls" })).toContain("sandboxed");
  expect(approve).not.toHaveBeenCalled();
  expect(commands).toEqual(["ls"]);
});

it("asks before each command on this computer, where the workspace is its own path", async () => {
  const root = workspace();
  const approve = vi.fn(async (): Promise<CommandApproval> => "deny");
  const setup = workingAgentSetup({ cwd: root, environment: await hostProvider.prepare(root), sandboxed: false, approveCommand: approve });
  expect(setup.systemPrompt).not.toContain("In commands the workspace is");
  const bash = setup.tools.find((tool) => tool.name === "bash");
  if (bash === undefined) throw new Error("No bash tool");
  await expect(call(bash, { command: "echo refused" })).rejects.toThrow("The operator declined this command");
  expect(approve).toHaveBeenCalledWith({ command: "echo refused", rule: ["echo", "refused"] }, expect.anything());
});

/** An environment standing for this computer, recording what ran there. */
function computer(): { environment: ExecutionEnvironment; commands: string[] } {
  const commands: string[] = [];
  return { commands, environment: { provider: "host", guarantees: hostProvider.guarantees, preparation: [],
    run: async (command, options) => { commands.push(command); options.onOutput(Buffer.from("on this computer\n")); return { outcome: "exited", exitCode: 0 }; },
    dispose: async () => {} } };
}

it("lets a sandboxed agent run one command on this computer only as the operator allows, with its reason and a rule to save", async () => {
  const root = workspace();
  const here = computer();
  const requests: CommandRequest[] = [];
  let answer: CommandApproval = "deny";
  const setup = workingAgentSetup({ cwd: root, environment: sandbox().environment, sandboxed: true, computer: here.environment,
    approveCommand: async (request) => { requests.push(request); return answer; } });
  expect(setup.systemPrompt).toContain("run_on_computer");
  const tool = setup.tools.find((candidate) => candidate.name === "run_on_computer");
  if (tool === undefined) throw new Error("No run_on_computer tool");
  await expect(call(tool, { command: "gh pr list", reason: "Only your gh is signed in.", rule: ["gh", "pr"] }))
    .rejects.toThrow("The operator declined this command");
  expect(here.commands).toEqual([]);
  answer = "once";
  expect(await call(tool, { command: "gh pr list", reason: "Only your gh is signed in.", rule: ["gh", "pr"] })).toContain("on this computer");
  expect(here.commands).toEqual(["gh pr list"]);
  // A rule the agent suggests is offered only when it may be saved; otherwise the command's own leading names are.
  await call(tool, { command: "python -c 'print(1)'", reason: "Your Python.", rule: ["python", "-c"] });
  expect(requests.map((request) => request.rule)).toEqual([["gh", "pr"], ["gh", "pr"], undefined]);
  expect(requests[0]?.reason).toBe("Only your gh is signed in.");
});

it("runs on this computer without asking what a saved rule covers, part by part, and asks for anything else", async () => {
  const root = workspace();
  const here = computer();
  const asked: string[] = [];
  const setup = workingAgentSetup({ cwd: root, environment: here.environment, sandboxed: false, commandRules: () => [["gh", "pr"], ["git", "status"]],
    approveCommand: async ({ command }) => { asked.push(command); return "deny"; } });
  const bash = setup.tools.find((tool) => tool.name === "bash");
  if (bash === undefined) throw new Error("No bash tool");
  await call(bash, { command: "gh pr list && git status --short" });
  await expect(call(bash, { command: "gh pr list && rm -rf build" })).rejects.toThrow("declined");
  await expect(call(bash, { command: "gh pr list > prs.txt" })).rejects.toThrow("declined");
  await expect(call(bash, { command: "gh repo delete x" })).rejects.toThrow("declined");
  expect(here.commands).toEqual(["gh pr list && git status --short"]);
  expect(asked).toEqual(["gh pr list && rm -rf build", "gh pr list > prs.txt", "gh repo delete x"]);
});

it("checks the repository's declared toolchain before each sandboxed command, and writes what it says first", async () => {
  const root = workspace();
  const { environment, commands } = sandbox();
  const here = computer();
  const order: string[] = [];
  const setup = workingAgentSetup({ cwd: root, environment, sandboxed: true, computer: here.environment,
    approveCommand: async () => "once",
    beforeSandboxCommand: async () => { order.push(`check before ${commands.length}`); return "Tesota: the tools are installed."; } });
  const bash = setup.tools.find((tool) => tool.name === "bash");
  const computerTool = setup.tools.find((tool) => tool.name === "run_on_computer");
  if (bash === undefined || computerTool === undefined) throw new Error("Missing tools");
  const output = await call(bash, { command: "dafny --version" });
  expect(output.indexOf("Tesota: the tools are installed.")).toBeLessThan(output.indexOf("sandboxed"));
  expect(order).toEqual(["check before 0"]);
  expect(commands).toEqual(["dafny --version"]);
  // A command on this computer uses the operator's own tools; the sandbox's toolchain is not checked for it.
  await call(computerTool, { command: "gh pr list", reason: "Your gh." });
  expect(order).toEqual(["check before 0"]);
  expect(setup.systemPrompt).toContain("declare it in the repository's mise.toml");
});

it("tells the agent to change files with its file tools and to keep scratch files out of the repository", () => {
  const setup = workingAgentSetup({ cwd: workspace(), environment: sandbox().environment, sandboxed: true,
    approveCommand: async () => "deny" });
  expect(setup.systemPrompt).toContain("Change the repository's files only with the edit and write tools, never with shell commands");
  expect(setup.systemPrompt).toContain("Do not leave scratch files, such as probes or one-off scripts, in the repository");
});

it.runIf(process.platform === "win32")("passes PowerShell through bash on this computer unchanged, as run_on_computer describes", async () => {
  const root = workspace();
  const setup = workingAgentSetup({ cwd: root, environment: sandbox().environment, sandboxed: true,
    computer: await hostProvider.prepare(root), approveCommand: async () => "once" });
  const tool = setup.tools.find((candidate) => candidate.name === "run_on_computer");
  if (tool === undefined) throw new Error("No run_on_computer tool");
  // The form the description gives, with PowerShell that bash would otherwise expand: $ variables and both quotes.
  const form = /powershell\.exe .*?\n<PowerShell commands>\nPS\n\)"/su.exec(tool.description)?.[0];
  expect(form).toBeDefined();
  const script = "$items = @('a', 'b')\n\"count=$($items.Count)\"\nif ($items.Count -gt 1) {\n  'more than one'\n}";
  const output = await call(tool, { command: form?.replace("<PowerShell commands>", script), reason: "Your PowerShell." });
  expect(output).toContain("count=2");
  expect(output).toContain("more than one");
}, 30_000);
