import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { kitDescriptor, kitDockerfile, kitRuntimes, writeToolchainKit } from "../src/docker-sandboxes-kit.js";
import { hasNodeModules, MISE_RELEASE, miseInstallScript, needsDownloadHosts, needsSetup, planToolchain }
  from "../src/toolchain.js";

const roots: string[] = [];
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
  expect(needsDownloadHosts(plan)).toBe(false);
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
  expect(needsDownloadHosts(plan)).toBe(true);
});

it("leaves mise's own files to mise and needs nothing for a bare repository", async () => {
  const withMise = planToolchain(await repository({ "mise.toml": "[tools]\ngo = \"1.25\"\n" }));
  expect(withMise).toMatchObject({ tools: {}, miseFiles: ["mise.toml"] });
  expect(needsDownloadHosts(withMise)).toBe(true);
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
