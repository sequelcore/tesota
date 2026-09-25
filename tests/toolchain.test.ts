import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { miseInstallScript, needsSetup, planToolchain, toolsInstallScript } from "../src/toolchain.js";

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
  expect(plan).toMatchObject({ tools: { node: "24.15.0", bun: "1.4.2" }, setupScript: null,
    dependencies: "bun install --frozen-lockfile", sources: ["package.json engines.node", "package.json packageManager"] });
  expect(needsSetup(plan)).toBe(true);
  expect(toolsInstallScript(plan)).toContain("mise use --global node@24.15.0 bun@1.4.2");
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

it("lets a repository setup script take over project setup", async () => {
  const plan = planToolchain(await repository({ ".tesota/setup.sh": "bun install\n", "bun.lock": "" }));
  expect(plan).toMatchObject({ tools: {}, setupScript: ".tesota/setup.sh", dependencies: null });
});

it("defers mise's own files to mise and needs nothing for a bare repository", async () => {
  const withMise = planToolchain(await repository({ "mise.toml": "[tools]\ngo = \"1.25\"\n" }));
  expect(withMise).toMatchObject({ tools: {}, sources: ["mise.toml"] });
  expect(toolsInstallScript(withMise)).toBe("set -eu\nmise install");
  expect(needsSetup(planToolchain(await repository({ "README.md": "hi" })))).toBe(false);
});

it("changes its fingerprint when setup inputs change", async () => {
  const root = await repository({ ".tesota/setup.sh": "echo one\n" });
  const first = planToolchain(root).fingerprint;
  await writeFile(join(root, ".tesota/setup.sh"), "echo two\n");
  expect(planToolchain(root).fingerprint).not.toBe(first);
});

it("checks the pinned mise binary before using it", () => {
  const script = miseInstallScript();
  expect(script).toContain("sha256sum -c -");
  expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf("chmod +x"));
});
