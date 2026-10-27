import { expect, test } from "bun:test";
import { type execFile, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { claudeCodeExecutable, claudeCodeProvider, claudeCodeStatus } from "../src/providers/claude-code.ts";

// Observe the real status wiring at its OS boundary, without executing the selected program.
test("the isolated runner redirects default Claude status away from the installed SDK (#680)", async () => {
  const root = process.env["TESOTA_ISOLATED"] ?? "missing-isolation";
  const selected: string[] = [];
  const execute = ((program: string, _args: unknown, _options: unknown, done: (error: null, stdout: string) => void) => {
    selected.push(program);
    done(null, '{"loggedIn":false}');
  }) as unknown as typeof execFile;
  await claudeCodeStatus(undefined, execute);
  expect(selected).toEqual([join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude")]);
  expect(claudeCodeExecutable()).toBe(process.env["CLAUDE_CODE_EXECUTABLE"]);
  expect(process.env["CLAUDE_CONFIG_DIR"]).toBe(join(root, "claude"));
  expect(Bun.which("claude")).toBe(process.env["CLAUDE_CODE_EXECUTABLE"] ?? null);
});

test("forgotten status and SDK fakes cannot start real Claude Code (#680)", async () => {
  expect(await claudeCodeStatus()).toEqual({ loggedIn: false });
  const models = createModels({ credentials: new InMemoryCredentialStore() });
  const provider = claudeCodeProvider(anthropicProvider().getModels());
  models.setProvider(provider);
  const model = models.getModels("claude-code")[0];
  if (model === undefined) throw new Error("missing Claude catalog");
  const reply = await models.streamSimple(model, { messages: [{ role: "user", content: "never send this", timestamp: 0 }] },
    { metadata: { cwd: tmpdir() } }).result();
  expect(reply.stopReason).toBe("error");
  expect(reply.errorMessage).toMatch(/Claude Code/u);
});

test("processes spawned without env inherit the Claude isolation (#680)", () => {
  const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify([process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CODE_EXECUTABLE, process.env.ANTHROPIC_AUTH_TOKEN]))"],
    { encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual([process.env["CLAUDE_CONFIG_DIR"], process.env["CLAUDE_CODE_EXECUTABLE"], null]);
});
