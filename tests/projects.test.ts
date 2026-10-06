import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { findProjects, inFolder } from "../src/projects.js";
import { planToolchain } from "../src/toolchain.js";
import { suggestChecks } from "../src/workspace-checks.js";

/**
 * Projects found at the root or in folders below it (#318), and the checks
 * suggested for each, run from its own folder.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tesota-projects-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

it("suggests a root Gradle project's check, through its wrapper when it has one", async () => {
  expect(suggestChecks(await repository({ "build.gradle.kts": "plugins { java }", "settings.gradle.kts": "", gradlew: "",
    "lib/build.gradle.kts": "" }))).toEqual(["./gradlew check"]);
  expect(suggestChecks(await repository({ "build.gradle": "" }))).toEqual(["gradle check"]);
});

it("suggests a root Maven project's verify, through its wrapper when it has one", async () => {
  expect(suggestChecks(await repository({ "pom.xml": "<project><modules><module>core</module></modules></project>", mvnw: "",
    "core/pom.xml": "<project/>" }))).toEqual(["./mvnw verify"]);
  expect(suggestChecks(await repository({ "pom.xml": "<project/>" }))).toEqual(["mvn verify"]);
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
  // A related form takes paths relative to the repository, so only the root's checks come with one.
  expect(suggestChecks(root)).toEqual(["cd backend && ./gradlew check", "cd frontend && bun run lint", "cd frontend && bun run test"]);
});

it("lets a subfolder's build keep its kind and checks when the root only states the version", async () => {
  const root = await repository({ ".java-version": "21\n", "frontend/package.json": JSON.stringify({ scripts: { check: "tsc" } }),
    "frontend/bun.lock": "", "backend/settings.gradle.kts": "", "backend/gradlew": "",
    "backend/build.gradle.kts": "java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }" });
  expect(findProjects(root).map(({ folder, kinds }) => ({ folder, kinds }))).toEqual([
    { folder: "", kinds: [] }, { folder: "backend", kinds: ["java"] }, { folder: "frontend", kinds: ["node"] }]);
  expect(suggestChecks(root)).toEqual(["cd backend && ./gradlew check", "cd frontend && bun run check"]);
  // The subfolder's own build states its release first; the root's file applies only where it states none.
  expect(planToolchain(root)).toMatchObject({ tools: { java: "25" }, sources: ["backend/build.gradle.kts"] });
  const unstated = await repository({ ".sdkmanrc": "java=21.0.4-tem\n", "global.json": "{ \"sdk\": { \"version\": \"9.0.100\" } }",
    "backend/pom.xml": "<project/>", "src/App/App.csproj": "" });
  expect(planToolchain(unstated)).toMatchObject({ tools: { java: "21.0.4", dotnet: "9.0.100" }, sources: [".sdkmanrc", "global.json"] });
  // With no build below, a folder that only states the version is still that language's project.
  expect(findProjects(await repository({ ".python-version": "3.12\n", "tools/README.md": "" }))[0]?.kinds).toEqual(["python"]);
});

it("keeps a root package's checks beside its subfolders' unless it declares workspaces", async () => {
  const tooling = await repository({ "package.json": JSON.stringify({ scripts: { lint: "prettier" } }),
    "web/package.json": JSON.stringify({ scripts: { check: "tsc" } }), "api/go.mod": "module api\n" });
  expect(suggestChecks(tooling)).toEqual(["npm run lint", "cd api && go test ./...", "cd web && npm run check"]);
  const workspaces = await repository({ "package.json": JSON.stringify({ workspaces: ["web"], scripts: { check: "all" } }),
    "web/package.json": JSON.stringify({ scripts: { check: "tsc" } }) });
  expect(suggestChecks(workspaces)).toEqual(["npm run check"]);
});

it("reads folders to a bounded depth", async () => {
  expect(suggestChecks(await repository({ "a/b/c/Cargo.toml": "" }))).toEqual(["cd a/b/c && cargo test"]);
  expect(suggestChecks(await repository({ "a/b/c/d/Cargo.toml": "" }))).toEqual([]);
});

it("quotes a folder the shell would otherwise split", () => {
  expect(inFolder("", "go test ./...")).toBe("go test ./...");
  expect(inFolder("my app", "npm test")).toBe("cd 'my app' && npm test");
  expect(inFolder("-x", "npm test")).toBe("cd ./-x && npm test");
  expect(inFolder("it's", "npm test")).toBe("cd 'it'\\''s' && npm test");
});
