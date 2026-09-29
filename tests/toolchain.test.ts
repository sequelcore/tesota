import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { kitDescriptor, kitDockerfile, kitRuntimes, writeToolchainKit } from "../src/docker-sandboxes-kit.js";
import { hasNodeModules, MISE_RELEASE, miseInstallScript, type MiseUse, missingRuntimes, needsDownloadHosts, needsSetup,
  planToolchain, setupStages } from "../src/toolchain.js";

const roots: string[] = [];
/** Docker's kit carries the runtimes; the WSL sandbox carries mise and installs what Tesota's own runtimes are not. */
const docker: MiseUse = { install: true, runtimes: {}, reach: "shims" };
const wsl = (runtimes: Record<string, string>): MiseUse => ({ install: false, runtimes, reach: "folders" });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tesota-toolchain-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

it("reads runtimes from package.json and installs from the lockfile", async () => {
  const plan = planToolchain(await repository({
    "package.json": JSON.stringify({ packageManager: "bun@1.4.2", engines: { node: "24.15.0" } }), "bun.lock": "",
  }));
  expect(plan).toMatchObject({ tools: { node: "24.15.0", bun: "1.4.2" }, miseFiles: [], setupScript: null,
    dependencies: "bun install --frozen-lockfile", sources: ["package.json engines.node", "package.json packageManager"] });
  expect(needsSetup(plan)).toBe(true);
  expect(needsDownloadHosts(plan, docker)).toBe(false);
  expect(needsDownloadHosts(plan, wsl({ node: "22" }))).toBe(true);
  expect(kitRuntimes(plan)).toEqual({ node: "24.15.0", bun: "1.4.2" });
});

it("keeps node_modules off the workspace mount for any root JavaScript package", async () => {
  expect(hasNodeModules(await repository({ "package.json": "{}", ".tesota/setup.sh": "bun install\n" }))).toBe(true);
  expect(hasNodeModules(await repository({ ".python-version": "3.13\n" }))).toBe(false);
});

it("prefers dedicated version files and skips ranges it cannot pin", async () => {
  const plan = planToolchain(await repository({
    ".nvmrc": "v22.1.0\n", ".bun-version": "1.3.0",
    "package.json": JSON.stringify({ packageManager: "bun@1.4.2", engines: { node: ">=18 <25" } }),
    "package-lock.json": "{}",
  }));
  expect(plan.tools).toEqual({ node: "22.1.0", bun: "1.3.0" });
  expect(plan.dependencies).toBe("npm ci");
});

it("lets a repository setup script take over project setup and reach download hosts", async () => {
  const plan = planToolchain(await repository({ ".tesota/setup.sh": "bun install\n", "bun.lock": "" }));
  expect(plan).toMatchObject({ tools: {}, setupScript: ".tesota/setup.sh", dependencies: null });
  expect(needsDownloadHosts(plan, docker)).toBe(true);
});

it("leaves mise's own files to mise and needs nothing for a bare repository", async () => {
  const withMise = planToolchain(await repository({ "mise.toml": "[tools]\ngo = \"1.25\"\n" }));
  expect(withMise).toMatchObject({ tools: {}, miseFiles: ["mise.toml"] });
  expect(needsDownloadHosts(withMise, docker)).toBe(true);
  expect(needsSetup(planToolchain(await repository({ "README.md": "hi" })))).toBe(false);
});

it("changes its fingerprint when setup inputs change", async () => {
  const root = await repository({ ".tesota/setup.sh": "echo one\n", "mise.toml": "[tools]\n" });
  const first = planToolchain(root).fingerprint;
  await writeFile(join(root, ".tesota/setup.sh"), "echo two\n");
  const second = planToolchain(root).fingerprint;
  await writeFile(join(root, "mise.toml"), "[tools]\ngo = \"1.25\"\n");
  expect(new Set([first, second, planToolchain(root).fingerprint]).size).toBe(3);
});

it("installs only the pinned runtimes an environment does not already carry at that version or a release of it", () => {
  const carried = { node: "24.15.0", bun: "1.4.2" };
  expect(missingRuntimes({ node: "24.15.0", bun: "1.4.2" }, carried)).toEqual({});
  expect(missingRuntimes({ node: "24", bun: "1.4" }, carried)).toEqual({});
  expect(missingRuntimes({ node: "24.1", bun: "1.3.0", python: "3.13" }, carried)).toEqual({ node: "24.1", bun: "1.3.0", python: "3.13" });
});

it("orders setup the same way everywhere: tools, then the setup script, then the lockfile install", async () => {
  const plan = planToolchain(await repository({ ".nvmrc": "20\n", "mise.toml": "[tools]\njq = \"1.7.1\"\n",
    ".tesota/setup.sh": "npm ci\n", "package-lock.json": "{}" }));
  expect(setupStages(plan, wsl({ node: "20" }))).toEqual([
    { description: "Install node 20 and the tools in mise.toml", script: "set -eu\nmise use --global node@20\nmise install" },
    { description: "Find the installed tools", script: "mise bin-paths", toolFolders: true },
    { description: "Run .tesota/setup.sh", script: "sh .tesota/setup.sh" }]);
  // Docker's kit carries the runtimes; its setup installs mise and reaches mise's own tools through the shims.
  expect(setupStages(plan, docker).map((stage) => stage.description)).toEqual(["Install mise", "Install the tools in mise.toml",
    "Run .tesota/setup.sh"]);
  const lockfileOnly = planToolchain(await repository({ "bun.lock": "" }));
  expect(setupStages(lockfileOnly, wsl({}))).toEqual([
    { description: "Install dependencies (bun install --frozen-lockfile)", script: "bun install --frozen-lockfile" }]);
  expect(setupStages(planToolchain(await repository({ "README.md": "hi" })), wsl({}))).toEqual([]);
});

it("checks the pinned mise binary before using it, in the sandbox and in the kit build", () => {
  const script = miseInstallScript();
  expect(script).toContain("sha256sum -c -");
  expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf("chmod +x"));
  const recipe = kitDockerfile();
  expect(recipe).toContain(MISE_RELEASE.sha256.x64);
  expect(recipe.indexOf("sha256sum -c -")).toBeLessThan(recipe.indexOf("mise install"));
});

it("bakes the pinned versions into a workload kit named by its content", async () => {
  const descriptor = kitDescriptor({ node: "24.15.0", bun: "1.4.2" });
  expect(descriptor.split("\n")[0]).toBe("# syntax=docker/sandbox-kit:3");
  expect(descriptor).toContain("kind: workload");
  expect(descriptor).toContain('  nodeVersion:\n    default: "24.15.0"');
  expect(descriptor).toContain('  pythonVersion:\n    default: ""');
  expect(descriptor).toContain("buildArg: BUN_VERSION");
  expect(descriptor).toContain('  dependenciesPath:\n    default: ""');
  expect(descriptor).toContain("env: TESOTA_DEPENDENCIES_PATH");
  expect(descriptor).toContain("com.docker.sandbox/volume@1");
  expect(descriptor).toContain('mount --bind /home/agent/.tesota-dependencies/node_modules "$TESOTA_DEPENDENCIES_PATH"');
  const root = await mkdtemp(join(tmpdir(), "tesota-kits-"));
  roots.push(root);
  const first = await writeToolchainKit({ node: "24.15.0", bun: "1.4.2" }, root);
  const same = await writeToolchainKit({ bun: "1.4.2", node: "24.15.0" }, root);
  const other = await writeToolchainKit({ node: "22.1.0" }, root);
  expect(same).toEqual(first);
  expect(other.id).not.toBe(first.id);
  expect(await readFile(join(first.directory, "tesota-shell.yaml"), "utf8")).toBe(descriptor);
  expect(await readFile(join(first.directory, "tesota-shell.dockerfile"), "utf8")).toBe(kitDockerfile());
});
