import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { kitDescriptor, kitDockerfile, kitRuntimes, writeToolchainKit } from "../src/docker-sandboxes-kit.js";
import { MISE_RELEASE, miseInstallScript, type MiseUse, missingRuntimes, needsDownloadHosts, needsSetup,
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
    installs: [{ folder: "", command: "bun install --frozen-lockfile" }], sources: ["package.json engines.node", "package.json packageManager"] });
  expect(needsSetup(plan)).toBe(true);
  expect(needsDownloadHosts(plan, docker)).toBe(false);
  expect(needsDownloadHosts(plan, wsl({ node: "22" }))).toBe(true);
  expect(kitRuntimes(plan)).toEqual({ node: "24.15.0", bun: "1.4.2" });
});

it("prefers dedicated version files and skips ranges it cannot pin", async () => {
  const plan = planToolchain(await repository({
    ".nvmrc": "v22.1.0\n", ".bun-version": "1.3.0",
    "package.json": JSON.stringify({ packageManager: "bun@1.4.2", engines: { node: ">=18 <25" } }),
    "package-lock.json": "{}",
  }));
  expect(plan.tools).toEqual({ node: "22.1.0", bun: "1.3.0" });
  expect(plan.installs).toEqual([{ folder: "", command: "npm ci" }]);
});

it("lets a repository setup script take over project setup and reach download hosts", async () => {
  const plan = planToolchain(await repository({ ".tesota/setup.sh": "bun install\n", "bun.lock": "" }));
  expect(plan).toMatchObject({ tools: {}, setupScript: ".tesota/setup.sh", installs: [] });
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

it("plans each project in a subfolder: its runtime, build tools, registries and lockfile install, from its own folder", async () => {
  const plan = planToolchain(await repository({
    "README.md": "monorepo",
    "frontend/package.json": JSON.stringify({ engines: { node: "22.11.0" }, scripts: { check: "tsc" } }),
    "frontend/bun.lock": "",
    "backend/build.gradle.kts": "kotlin { jvmToolchain(25) }",
    "backend/settings.gradle.kts": "rootProject.name = \"api\"",
    "backend/gradlew": "",
    "backend/app/build.gradle.kts": "",
  }));
  expect(plan.tools).toEqual({ node: "22.11.0", java: "25" });
  expect(plan.sources).toEqual(["frontend/package.json engines.node", "backend/build.gradle.kts"]);
  expect(plan.registries).toContain("plugins.gradle.org");
  expect(plan.installs).toEqual([{ folder: "frontend", command: "bun install --frozen-lockfile" }]);
  expect(plan.packages).toEqual(["frontend"]);
  expect(setupStages(plan, wsl({})).at(-1)).toEqual({ description: "Install dependencies in frontend (bun install --frozen-lockfile)",
    script: "cd frontend && bun install --frozen-lockfile" });
  // A project without a wrapper gets its build tool, wherever it is.
  expect(planToolchain(await repository({ "services/api/pom.xml": "<java.version>17</java.version>" })).tools)
    .toEqual({ java: "17", maven: "latest" });
});

it("uses an ancestor's .NET SDK pin before a child project's target framework", async () => {
  const plan = planToolchain(await repository({
    "global.json": '{ "sdk": { "version": "9.0.100" } }',
    "app/App.csproj": "<TargetFramework>net8.0</TargetFramework>",
  }));
  expect(plan.tools).toEqual({ dotnet: "9.0.100" });
  expect(plan.sources).toEqual(["global.json"]);
});

it("uses an ancestor's Python pin before a child project's minimum requirement", async () => {
  const plan = planToolchain(await repository({
    ".python-version": "3.12\n",
    "app/pyproject.toml": '[project]\nrequires-python = ">=3.10"\n',
  }));
  expect(plan.tools).toEqual({ python: "3.12" });
  expect(plan.sources).toEqual([".python-version"]);
});

it("uses a project's local SDK pin before an ancestor's pin", async () => {
  const plan = planToolchain(await repository({
    "global.json": '{ "sdk": { "version": "9.0.100" } }',
    "app/global.json": '{ "sdk": { "version": "10.0.100" } }',
    "app/App.csproj": "<TargetFramework>net8.0</TargetFramework>",
  }));
  expect(plan.tools).toEqual({ dotnet: "10.0.100" });
  expect(plan.sources).toEqual(["app/global.json"]);
});

it("keeps exact Python and Ruby declarations ahead of an ancestor's version file", async () => {
  expect(planToolchain(await repository({
    ".python-version": "3.12\n",
    "app/pyproject.toml": '[project]\nrequires-python = "==3.11.9"\n',
  })).tools).toEqual({ python: "3.11.9" });
  expect(planToolchain(await repository({
    ".ruby-version": "3.4\n", "app/Gemfile": "ruby '3.3.5'\n",
  })).tools).toEqual({ ruby: "3.3.5" });
});

it("keeps an ancestor's Java toolchain pin ahead of a Maven compilation target", async () => {
  expect(planToolchain(await repository({
    ".java-version": "21\n", "app/pom.xml": "<maven.compiler.release>17</maven.compiler.release>",
  })).tools).toEqual({ java: "21", maven: "latest" });
});

it("uses a local Pipfile pin ahead of both a Python minimum and an ancestor's pin", async () => {
  const plan = planToolchain(await repository({
    ".python-version": "3.12\n", "app/pyproject.toml": '[project]\nrequires-python = ">=3.10"\n',
    "app/Pipfile": '[requires]\npython_full_version = "3.11.9"\n',
  }));
  expect(plan.tools).toEqual({ python: "3.11.9" });
  expect(plan.sources).toEqual(["app/Pipfile"]);
});

it("uses an exact Gradle toolchain ahead of a Maven target in the same folder", async () => {
  const plan = planToolchain(await repository({
    ".java-version": "21\n", "app/pom.xml": "<maven.compiler.release>17</maven.compiler.release>",
    "app/build.gradle.kts": "java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }",
  }));
  expect(plan.tools).toEqual({ java: "25", maven: "latest", gradle: "latest" });
  expect(plan.sources).toEqual(["app/build.gradle.kts"]);
});

it("inherits the nearest ancestor's version file across directories without a build", async () => {
  const plan = planToolchain(await repository({
    ".python-version": "3.12\n", "apps/.python-version": "3.13\n",
    "apps/service/pyproject.toml": '[project]\nrequires-python = ">=3.10"\n',
  }));
  expect(plan.tools).toEqual({ python: "3.13" });
  expect(plan.sources).toEqual(["apps/.python-version"]);
});

it("leaves a workspace's packages to the root's install, but mounts their node_modules too", async () => {
  const plan = planToolchain(await repository({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "bun.lock": "",
    "packages/ui/package.json": JSON.stringify({ engines: { node: "20" } }), "packages/ui/bun.lock": "",
  }));
  expect(plan.installs).toEqual([{ folder: "", command: "bun install --frozen-lockfile" }]);
  expect(plan.tools).toEqual({});
  expect(plan.packages).toEqual(["packages/ui"]);
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
  expect(descriptor).toContain('  dependenciesPaths:\n    default: ""');
  expect(descriptor).toContain("env: TESOTA_DEPENDENCIES_PATHS");
  expect(descriptor).toContain("com.docker.sandbox/volume@1");
  // Each node_modules, the root's and each package's, gets its own folder of the volume.
  expect(descriptor).toContain("IFS=:; for target in $TESOTA_DEPENDENCIES_PATHS;");
  expect(descriptor).toContain('mount --bind "/home/agent/.tesota-dependencies$target" "$target"');
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
