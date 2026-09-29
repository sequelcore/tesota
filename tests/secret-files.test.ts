import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readOnlyFileTools } from "../src/integrations/pi-coding-session.js";
import { hiddenFiles, isSecretPath } from "../src/secret-files.js";

/**
 * Working in the source, the agent could read what the operator keeps beside
 * the work; environment files, private keys and registry credentials are
 * hidden by default, as Gemini CLI hides `.env` and `.env.*`.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function source(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tesota-secrets-")));
  roots.push(root);
  await mkdir(join(root, "api"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, ".cargo"));
  await writeFile(join(root, "api", ".env"), "TOKEN=secret-value\n");
  await writeFile(join(root, ".env.example"), "TOKEN=\n");
  await writeFile(join(root, "deploy.key"), "private\n");
  await writeFile(join(root, ".cargo", "credentials.toml"), "token\n");
  await writeFile(join(root, "node_modules", "pkg", ".env"), "not the operator's\n");
  await writeFile(join(root, "config.ts"), "export const token = process.env.TOKEN;\n");
  return root;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}

it("names environment files, private keys and registry credentials, and nothing merely similar", () => {
  for (const path of [".env", "api/.env.local", "id_ed25519", "certs/server.key", "store.p12", ".npmrc", ".netrc",
    ".cargo/credentials.toml", ".aws/credentials", ".docker/config.json"]) expect(isSecretPath(path), path).toBe(true);
  for (const path of ["env.ts", ".environment", "credentials", "src/credentials.ts", "config.json", "keys.ts", ".key"]) {
    expect(isSecretPath(path), path).toBe(false);
  }
});

it("hides every secret a folder holds, outside dependency folders", async () => {
  const root = await source();
  expect(await hiddenFiles(root, "folder")).toEqual([".cargo/credentials.toml", ".env.example", "api/.env", "deploy.key"]);
  expect(await hiddenFiles(root, "folder", ["api/.env"])).toEqual([".cargo/credentials.toml", ".env.example", "deploy.key"]);
});

it("leaves visible what a repository tracks, which is shared work", async () => {
  const root = await source();
  git(root, "init", "--quiet");
  await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n");
  git(root, "add", ".env.example", ".gitignore", "config.ts");
  git(root, "commit", "--quiet", "-m", "Fixture");
  expect(await hiddenFiles(root, "repository")).toEqual([".cargo/credentials.toml", "api/.env", "deploy.key"]);
});

it("keeps hidden files from the agent's file tools, and grep's lines from them", async () => {
  const root = await source();
  const tools = readOnlyFileTools(root);
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Missing ${name}`);
    return tool.execute("c", args as never, new AbortController().signal, undefined, undefined as never);
  };
  await expect(call("read", { path: "api/.env" })).rejects.toThrow("api/.env is hidden from the agent");
  await expect(call("read", { path: "config.ts" })).resolves.toBeDefined();
  const found = await call("grep", { pattern: "TOKEN", path: "." });
  const text = JSON.stringify(found.content);
  expect(text).toContain("config.ts");
  expect(text).not.toContain("secret-value");
  const inside = await call("grep", { pattern: "secret-value", path: "api" });
  expect(JSON.stringify(inside.content)).toContain("No matches found");
});
