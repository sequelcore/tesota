import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EnvironmentGuarantees, ExecutionProvider, ProviderReadiness } from "../src/execution-environment.js";
import type { QualificationRecord } from "../src/execution-qualification.js";
import { readSandboxPreference } from "../src/execution-providers.js";
import { runSandboxCommand } from "../src/sandbox-command.js";

/**
 * `tesota sandbox` (decision 030): what each sandbox proved on this computer,
 * which one new sessions use, the operator's choice, and a repository's
 * package cache.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const confined: EnvironmentGuarantees = { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" };
function provider(name: string, readiness: ProviderReadiness): ExecutionProvider {
  return { name, guarantees: confined, readiness: async () => readiness,
    prepare: async () => { throw new Error("unused"); }, release: async () => {} };
}
const wsl = provider("wsl", { ready: true });
const docker = provider("docker-sandboxes", { ready: false, steps: [{ description: "Sign in to Docker", command: "sbx login" }] });
const qualified: QualificationRecord = { provider: "wsl", fingerprint: "windows 10.0.26200", at: "2026-09-26T12:00:00.000Z",
  guarantees: confined, results: [{ control: "workspace_read_write", passed: true, detail: "" }] };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tesota-sandbox-command-"));
  roots.push(root);
  let output = "";
  const dependencies = { preferencePath: join(root, "sandbox.json"), cacheDirectory: join(root, "cache", "repo"),
    providers: (preference: string) => preference === "wsl" ? [wsl] : preference === "docker" ? [docker] : preference === "host" ? [] : [wsl, docker],
    candidates: [wsl, docker], trust: async (candidate: ExecutionProvider) => candidate === wsl ? qualified : undefined };
  return { root, dependencies, write: (text: string) => { output += text; }, output: () => output };
}

it("lists what each sandbox proved on this computer, and which one new sessions use", async () => {
  const { dependencies, write, output } = setup();
  expect(await runSandboxCommand([], write, dependencies)).toBe(0);
  expect(output()).toContain("Where commands run (auto: the WSL sandbox, then Docker Sandboxes, then this computer):");
  expect(output()).toContain("wsl      in use: ready; every control passed on this computer on 2026-09-26");
  expect(output()).toContain("docker   not ready: Sign in to Docker (sbx login)");
  expect(output()).toContain("host     this computer, always available; asks before each command");
});

it("says why a ready sandbox that does not confine the network is not used", async () => {
  const { dependencies, write, output } = setup();
  const open = { ...provider("docker-sandboxes", { ready: true }), guarantees: { ...confined, network: "open" as const } };
  expect(await runSandboxCommand([], write, { ...dependencies, candidates: [open], providers: () => [open] })).toBe(0);
  expect(output()).toContain("docker   ready, but it does not confine the network to an allowlist; commands ask first");
  expect(output()).toContain("host     in use: this computer");
});

it("keeps the operator's choice for new sessions, and refuses what is not a choice", async () => {
  const { dependencies, write, output } = setup();
  expect(await runSandboxCommand(["use", "docker"], write, dependencies)).toBe(0);
  expect(readSandboxPreference(dependencies.preferencePath)).toBe("docker");
  expect(output()).toContain("New sessions use Docker Sandboxes.");
  expect(await runSandboxCommand(["use", "vm"], write, dependencies)).toBe(2);
  expect(output()).toContain("Usage: tesota sandbox [use <auto|wsl|docker|host> | clean]");
  await runSandboxCommand([], write, dependencies);
  // The chosen sandbox is not ready, so new sessions run on this computer and say so.
  expect(output()).toContain("host     in use: this computer, always available; asks before each command");
});

it("removes this repository's package cache, and says when there is none", async () => {
  const { dependencies, write, output } = setup();
  mkdirSync(dependencies.cacheDirectory, { recursive: true });
  writeFileSync(join(dependencies.cacheDirectory, "package.tgz"), "x");
  expect(await runSandboxCommand(["clean"], write, dependencies)).toBe(0);
  expect(existsSync(dependencies.cacheDirectory)).toBe(false);
  expect(output()).toContain("Removed this repository's package cache.");
  expect(await runSandboxCommand(["clean"], write, dependencies)).toBe(0);
  expect(output()).toContain("This repository has no package cache.");
});
