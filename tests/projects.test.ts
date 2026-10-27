import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { below, builtIn, holds, owner, pinnedIn } from "../src/verification/project-rule.js";
import { findProjects, inFolder, owningProjects, packageTest, suggestChecks } from "../src/projects.js";

/**
 * Projects found at the root or in folders below it (#318), and the checks
 * suggested for each, run from its own folder.
 */
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A `PATH` holding only these programs, so a package without a lockfile does not depend on the machine's (#576). */
async function onPath(...programs: string[]): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), "tesota-path-"));
  roots.push(bin);
  for (const program of programs) {
    if (process.platform === "win32") await writeFile(join(bin, `${program}.cmd`), "@echo off\r\n");
    else await writeFile(join(bin, program), "#!/bin/sh\n", { mode: 0o755 });
  }
  vi.stubEnv("PATH", bin);
  if (process.platform === "win32") vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
}

beforeEach(async () => { await onPath("npm"); });

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tesota-projects-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** Every project's suggested commands, in order. */
function commands(root: string): string[] {
  return suggestChecks(root).flatMap((project) => project.commands);
}

it("reads a package.json that begins with a byte-order mark, as Windows tools may write one (#470)", async () => {
    const root = await repository({ "package.json": `\uFEFF${JSON.stringify({ scripts: { test: "node --test" } })}`, "bun.lock": "" });
    expect(commands(root)).toEqual(["bun run test"]);
});

it("runs a package without a lockfile with the package manager its packageManager field names (#576)", async () => {
  const scripts = { test: "bun test" };
  const bun = await repository({ "package.json": JSON.stringify({ packageManager: "bun@1.4.2", scripts }) });
  expect(commands(bun)).toEqual(["bun run test"]);
  expect(packageTest(bun, "")).toEqual({ script: "bun test", command: "bun run test" });
  expect(commands(await repository({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0+sha512.abc", scripts }) })))
    .toEqual(["pnpm run test"]);
  // A field naming no package manager Tesota knows says nothing; the lockfile does.
  expect(commands(await repository({ "package.json": JSON.stringify({ packageManager: "deno@2", scripts }), "yarn.lock": "" })))
    .toEqual(["yarn run test"]);
});

it("runs a package without a lockfile or packageManager field with a runner on the PATH (#576)", async () => {
  const root = await repository({ "package.json": JSON.stringify({ scripts: { test: "bun test" } }) });
  expect(commands(root)).toEqual(["npm run test"]);
  expect(packageTest(root, "")).toEqual({ script: "bun test", command: "npm run test --" });
  await onPath("bun");
  expect(commands(root)).toEqual(["bun run test"]);
  expect(packageTest(root, "")).toEqual({ script: "bun test", command: "bun run test" });
  await onPath("yarn", "pnpm");
  expect(commands(root)).toEqual(["pnpm run test"]);
  // With no runner found, the command names npm, and fails as the operator's own would.
  await onPath();
  expect(commands(root)).toEqual(["npm run test"]);
});

it("suggests a root Gradle project's check, through its wrapper when it has one", async () => {
  expect(commands(await repository({ "build.gradle.kts": "plugins { java }", "settings.gradle.kts": "", gradlew: "",
    "lib/build.gradle.kts": "" }))).toEqual(["./gradlew check"]);
  expect(commands(await repository({ "build.gradle": "" }))).toEqual(["gradle check"]);
});

it("suggests a root Maven project's verify, through its wrapper when it has one", async () => {
  expect(commands(await repository({ "pom.xml": "<project><modules><module>core</module></modules></project>", mvnw: "",
    "core/pom.xml": "<project/>" }))).toEqual(["./mvnw verify"]);
  expect(commands(await repository({ "pom.xml": "<project/>" }))).toEqual(["mvn verify"]);
});

it("finds a monorepo's JavaScript app and Gradle project in subfolders and runs each one's checks in its folder", async () => {
  const root = await repository({
    "README.md": "monorepo",
    "frontend/package.json": JSON.stringify({ scripts: { lint: "eslint", test: "vitest" }, devDependencies: { vitest: "4" } }),
    "frontend/bun.lock": "",
    "backend/settings.gradle.kts": "", "backend/build.gradle.kts": "", "backend/gradlew": "",
    "backend/app/build.gradle.kts": "",
    "backend/build/tmp/package.json": "{}",
    ".github/workflows/package.json": "{}",
  });
  expect(findProjects(root)).toEqual([
    { folder: "backend", entries: ["app", "build", "build.gradle.kts", "gradlew", "settings.gradle.kts"], kinds: ["java"] },
    { folder: "frontend", entries: ["bun.lock", "package.json"], kinds: ["node"] },
    { folder: "backend/app", entries: ["build.gradle.kts"], kinds: [] },
  ]);
  expect(commands(root)).toEqual(["cd backend && ./gradlew check", "cd frontend && bun run lint", "cd frontend && bun run test"]);
});

it("lets a subfolder's build keep its kind and checks when the root only states the version", async () => {
  const root = await repository({ ".java-version": "21\n", "frontend/package.json": JSON.stringify({ scripts: { check: "tsc" } }),
    "frontend/bun.lock": "", "backend/settings.gradle.kts": "", "backend/gradlew": "",
    "backend/build.gradle.kts": "java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }" });
  expect(findProjects(root).map(({ folder, kinds }) => ({ folder, kinds }))).toEqual([
    { folder: "", kinds: [] }, { folder: "backend", kinds: ["java"] }, { folder: "frontend", kinds: ["node"] }]);
  expect(commands(root)).toEqual(["cd backend && ./gradlew check", "cd frontend && bun run check"]);
  // With no build below, a folder that only states the version is still that language's project.
  expect(findProjects(await repository({ ".java-version": "21\n", "tools/README.md": "" }))[0]?.kinds).toEqual(["java"]);
});

it("keeps a root package's checks beside its subfolders', including workspace members (#674)", async () => {
  const tooling = await repository({ "package.json": JSON.stringify({ scripts: { lint: "prettier" } }),
    "web/package.json": JSON.stringify({ scripts: { check: "tsc" } }), "api/go.mod": "module api\n" });
  expect(commands(tooling)).toEqual(["npm run lint", "cd api && go test ./...", "cd web && npm run check"]);
  const workspaces = await repository({ "package.json": JSON.stringify({ workspaces: ["web"], scripts: { check: "all" } }),
    "web/package.json": JSON.stringify({ scripts: { check: "tsc" } }) });
  expect(commands(workspaces)).toEqual(["npm run check", "cd web && npm run check"]);
  expect(owningProjects(suggestChecks(workspaces), ["web/a.test.ts"]).map(({ folder }) => folder)).toEqual(["web"]);
  expect(owningProjects(suggestChecks(workspaces), ["tools/a.test.ts"]).map(({ folder }) => folder)).toEqual([""]);
});

it("gives Tesota's engine tests to packages/core and root files to the root (#638, #674)", () => {
  const root = process.cwd();
  const projects = suggestChecks(root);
  expect(findProjects(root).find(({ folder }) => folder === "packages/core")?.kinds).toContain("node");
  expect(owningProjects(projects, ["packages/core/tests/extension.test.ts", "packages/core/tests/gate.test.ts"]))
    .toEqual([{ folder: "packages/core", commands: ["cd packages/core && npm run check"] }]);
  expect(owningProjects(projects, ["tests/projects.test.ts"]).map(({ folder }) => folder)).toEqual([""]);
  expect(packageTest(root, "packages/core")).toEqual({
    command: "cd packages/core && npm run test --", script: "bun scripts/isolated.ts bun test --timeout 30000",
  });
});

it("keeps a version-only root when descendants also only state versions", async () => {
  const root = await repository({ ".java-version": "21\n", "tools/.java-version": "25\n" });
  expect(findProjects(root)[0]?.kinds).toEqual(["java"]);
});

it("reads folders to a bounded depth", async () => {
  expect(commands(await repository({ "a/b/c/Cargo.toml": "" }))).toEqual(["cd a/b/c && cargo test"]);
  expect(commands(await repository({ "a/b/c/d/Cargo.toml": "" }))).toEqual([]);
});

it("distinguishes descendants from equal folders and sibling prefixes", () => {
  expect(below("", "app")).toBe(true);
  expect(below("", "")).toBe(false);
  expect(below("app", "app/service")).toBe(true);
  expect(below("app", "app")).toBe(false);
  expect(below("app", "apple/service")).toBe(false);
  expect(below("app/service", "app")).toBe(false);
});

it("recognizes build markers and version-only directories independently", () => {
  expect(builtIn(["*.csproj"], ["App.csproj"])).toBe(true);
  expect(builtIn(["*.csproj"], ["App.csproj.bak"])).toBe(false);
  expect(builtIn(["pom.xml"], ["my-pom.xml"])).toBe(false);
  expect(pinnedIn(["pom.xml"], [".java-version"], [".java-version"])).toBe(true);
  expect(pinnedIn(["pom.xml"], [".java-version"], ["pom.xml", ".java-version"])).toBe(false);
  expect(pinnedIn(["pom.xml"], [".java-version"], [])).toBe(false);
});

it("quotes a folder the shell would otherwise split", () => {
  expect(inFolder("", "go test ./...")).toBe("go test ./...");
  expect(inFolder("my app", "npm test")).toBe("cd 'my app' && npm test");
  expect(inFolder("-x", "npm test")).toBe("cd ./-x && npm test");
  expect(inFolder("it's", "npm test")).toBe("cd 'it'\\''s' && npm test");
});

it("gives a changed file to the deepest project that holds it", async () => {
  expect(holds("", "a.ts")).toBe(true);
  expect(holds("web", "web/a.ts")).toBe(true);
  expect(holds("web", "website/a.ts")).toBe(false);
  expect(owner(["", "web", "web/app"], "web/app/a.ts")).toBe(2);
  expect(owner(["web/app", "", "web"], "web/b.ts")).toBe(2);
  expect(owner(["api", "web"], "docs/a.md")).toBe(-1);
  const root = await repository({ "package.json": JSON.stringify({ scripts: { lint: "prettier" } }),
    "web/package.json": JSON.stringify({ scripts: { test: "vitest" } }), "api/go.mod": "module api\n" });
  const projects = suggestChecks(root);
  expect(owningProjects(projects, ["web/src/a.ts"]).map(({ commands: run }) => run)).toEqual([["cd web && npm run test"]]);
  expect(owningProjects(projects, ["api/main.go", "README.md"]).map(({ folder }) => folder)).toEqual(["", "api"]);
});
