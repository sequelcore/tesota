import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import { hostProvider } from "../src/host-environment.js";
import { workingAgentSetup } from "../src/integrations/pi-coding-session.js";

/**
 * The agent's shell in the native Windows sandbox (decision 030): a
 * `powershell` tool that says where it runs, and a retry on the operator's
 * computer that runs only after the operator approves it.
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
  return { commands, environment: { provider: "mxc", shell: "powershell", commandRoot: "T:\\",
    guarantees: { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" }, preparation: [],
    run: async (command, options) => { commands.push(command); options.onOutput(Buffer.from("sandboxed\n")); return { outcome: "exited", exitCode: 0 }; },
    dispose: async () => {} } };
}

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("c1", args as never, new AbortController().signal, undefined, undefined as never);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

it("gives the agent a powershell tool in the native sandbox, and says where it runs", () => {
  const root = workspace();
  const { environment } = sandbox();
  const setup = workingAgentSetup({ cwd: root, environment, sandboxed: true, approveCommand: async () => "deny" });
  const names = setup.tools.map((tool) => tool.name);
  expect(names).toContain("powershell");
  expect(names).not.toContain("bash");
  expect(setup.systemPrompt).toContain("Windows PowerShell 5.1");
  expect(setup.systemPrompt).toContain("the drive T:\\");
  expect(setup.systemPrompt).toContain("outside_sandbox");
  expect(JSON.stringify(setup.tools.find((tool) => tool.name === "powershell")?.parameters)).toContain("outside_sandbox");
});

it("runs a command in the sandbox without asking, and on this computer only after the operator approves", async () => {
  const root = workspace();
  const { environment, commands } = sandbox();
  const approve = vi.fn(async (): Promise<"once" | "always" | "deny"> => "once");
  const tool = workingAgentSetup({ cwd: root, environment, sandboxed: true, approveCommand: approve }).tools
    .find((entry) => entry.name === "powershell");
  if (tool === undefined) throw new Error("No powershell tool");
  expect(await call(tool, { command: "Get-ChildItem" })).toContain("sandboxed");
  expect(approve).not.toHaveBeenCalled();
  expect(commands).toEqual(["Get-ChildItem"]);
  expect(await call(tool, { command: "echo on-this-computer", outside_sandbox: true })).toContain("on-this-computer");
  expect(approve).toHaveBeenCalledWith("echo on-this-computer", expect.anything());
  expect(commands).toEqual(["Get-ChildItem"]);
  approve.mockResolvedValueOnce("deny");
  // A declined command fails, and Pi gives the agent its output as the tool's error.
  await expect(call(tool, { command: "echo refused", outside_sandbox: true })).rejects.toThrow("The operator declined this command");
}, 60_000);

it("keeps bash, with no retry, where commands already run on this computer or in Docker Sandboxes", async () => {
  const root = workspace();
  const setup = workingAgentSetup({ cwd: root, environment: await hostProvider.prepare(root), sandboxed: false,
    approveCommand: async () => "deny" });
  const bash = setup.tools.find((tool) => tool.name === "bash");
  expect(bash).toBeDefined();
  expect(JSON.stringify(bash?.parameters)).not.toContain("outside_sandbox");
  expect(setup.systemPrompt).not.toContain("PowerShell");
});
