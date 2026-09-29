import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import { hostProvider } from "../src/host-environment.js";
import { workingAgentSetup } from "../src/integrations/pi-coding-session.js";

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

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("c1", args as never, new AbortController().signal, undefined, undefined as never);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

it("runs the agent's bash commands in the sandbox without asking, and says where the workspace appears to them", async () => {
  const root = workspace();
  const { environment, commands } = sandbox();
  const approve = vi.fn(async (): Promise<"once" | "always" | "deny"> => "deny");
  const setup = workingAgentSetup({ cwd: root, environment, sandboxed: true, approveCommand: approve });
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
  const approve = vi.fn(async (): Promise<"once" | "always" | "deny"> => "deny");
  const setup = workingAgentSetup({ cwd: root, environment: await hostProvider.prepare(root), sandboxed: false, approveCommand: approve });
  expect(setup.systemPrompt).not.toContain("In commands the workspace is");
  const bash = setup.tools.find((tool) => tool.name === "bash");
  if (bash === undefined) throw new Error("No bash tool");
  await expect(call(bash, { command: "echo refused" })).rejects.toThrow("The operator declined this command");
  expect(approve).toHaveBeenCalledWith("echo refused", expect.anything());
});
