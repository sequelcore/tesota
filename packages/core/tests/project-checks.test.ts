import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { provideHost } from "../../../src/host.ts";
import { readDeclaredChecks } from "../../../src/project-checks.ts";
import { owningProjects, suggestChecks } from "../../../src/projects.ts";
import { exerciseTests, runCommands } from "../../../src/test-rung.ts";
import { shellHost } from "../src/shell/surface.ts";
import { trust } from "../src/trust.ts";
import { noOperations, type OperationSink } from "../../../src/operations.ts";
import { runPrint } from "../src/print.ts";

provideHost(shellHost());
const signal = (): AbortSignal => new AbortController().signal;
function fixture(commands = [{ command: "node check.cjs", folder: "", report: "result.xml" }]): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "tesota-declared-"));
  mkdirSync(join(root, ".tesota"));
  writeFileSync(join(root, ".tesota/checks.json"), JSON.stringify({ checks: commands }));
  writeFileSync(join(root, "check.cjs"), "require('fs').writeFileSync('ran', 'yes'); require('fs').writeFileSync('result.xml', '<testsuite tests=\"1\"><testcase name=\"legacy\"><failure/></testcase></testsuite>'); process.exit(1);\n");
  writeFileSync(join(root, "source.py"), "value = 1\n");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "source.py"), "value = 2\n");
  return { root, base };
}
function approve(root: string): void {
  const declaration = readDeclaredChecks(root);
  if (declaration.status !== "read") throw new Error("invalid fixture");
  mkdirSync(tesotaHome(), { recursive: true });
  trust(root, "checks", declaration.hash);
}

test("untrusted declarations execute nothing; approved checks attribute a non-manifest project's failure on the real base (#753)", async () => {
  const { root, base } = fixture();
  const [refused] = await runCommands(root, suggestChecks(root), ["source.py"], signal());
  expect(refused?.evidence.outcome).toBe("not_started");
  expect(existsSync(join(root, "ran"))).toBe(false);
  approve(root);
  const [ran] = await runCommands(root, suggestChecks(root), ["source.py"], signal(), undefined, undefined, { base });
  expect(ran?.origin?.cause).toBe("preexisting");
  expect(ran?.failingTests).toEqual(["legacy"]);
  expect(readFileSync(join(root, "ran"), "utf8")).toBe("yes");
});

test("print mode reports untrusted declarations without prompting or granting trust (#753)", async () => {
  const { root } = fixture();
  const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage("Explained.")]);
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  let errors = "";
  const code = await runPrint(["Explain the project.", "--model", `${model.provider}/${model.id}`], root,
    { out: () => undefined, error: (text) => { errors += text; } }, { "open-cases-model": "off" }, join(root, "settings.json"), models);
  expect(code).toBe(0);
  expect(errors).toContain("declared checks do not run: trust them in the shell first");
  expect(suggestChecks(root)[0]?.unavailable).toContain("not trusted");
  expect(existsSync(join(root, "ran"))).toBe(false);
});

test("changing declarations or revoking trust between commands prevents every later effect (#753)", async () => {
  for (const revoke of [false, true]) {
    const { root } = fixture([{ command: "node -e \"require('fs').writeFileSync('first', 'yes')\"", folder: "", report: "first.xml" },
      { command: "node -e \"require('fs').writeFileSync('second', 'yes')\"", folder: "", report: "second.xml" }]);
    approve(root);
    const selected = suggestChecks(root);
    let count = 0;
    const ops: OperationSink = { ...noOperations, run: async (_spec, work) => {
      const ran = await work();
      if (++count === 1) {
        if (revoke) rmSync(join(tesotaHome(), "trust.json"));
        else writeFileSync(join(root, ".tesota/checks.json"), '{"checks":[{"command":"changed","folder":""}]}');
      }
      return ran;
    } };
    const runs = await runCommands(root, selected, ["source.py"], signal(), ops);
    expect(runs.map(({ evidence }) => evidence.outcome)).toEqual(["passed", "not_started"]);
    expect(existsSync(join(root, "first"))).toBe(true);
    expect(existsSync(join(root, "second"))).toBe(false);
  }
});

test("a declared command's execution folder is independent from the changed paths that select it (#753)", async () => {
  const { root } = fixture([{ command: "node check.cjs", folder: "tooling", report: "result.xml" }]);
  mkdirSync(join(root, "tooling"));
  writeFileSync(join(root, "tooling/check.cjs"), readFileSync(join(root, "check.cjs")));
  approve(root);
  const selected = owningProjects(suggestChecks(root), ["source.py"]);
  const [run] = await runCommands(root, selected, ["source.py"], signal());
  expect(run?.command).toBe("cd tooling && node check.cjs");
  expect(run?.evidence.outcome).toBe("failed");
  expect(existsSync(join(root, "tooling/ran"))).toBe(true);
  expect(existsSync(join(root, "ran"))).toBe(false);
  expect(run?.failingTests).toEqual(["legacy"]);
});

test("a session in a repository subdirectory uses the root declaration and its corresponding base checkout (#753)", async () => {
  const { root, base } = fixture();
  const scope = join(root, "component"); mkdirSync(scope);
  writeFileSync(join(scope, "local.py"), "value = 2\n");
  approve(root);
  const selected = owningProjects(suggestChecks(scope), ["local.py"]);
  const [run] = await runCommands(scope, selected, ["local.py"], signal(), undefined, undefined, { base });
  expect(run?.evidence.outcome).toBe("failed");
  expect(run?.origin?.cause).toBe("preexisting");
  expect(existsSync(join(root, "ran"))).toBe(true);
  expect(existsSync(join(scope, "ran"))).toBe(false);
});

test("a stale declared report is removed before execution and cannot attribute a new failure (#753)", async () => {
  const { root, base } = fixture();
  approve(root);
  writeFileSync(join(root, "result.xml"), '<testsuite tests="1"><testcase name="legacy"><failure/></testcase></testsuite>');
  writeFileSync(join(root, "check.cjs"), "process.exit(1);\n");
  const [run] = await runCommands(root, suggestChecks(root), ["source.py", "check.cjs"], signal(), undefined, undefined, { base });
  expect(run?.origin?.cause).toBe("unknown");
  expect(run?.failingTests).toBeUndefined();
  expect(existsSync(join(root, "result.xml"))).toBe(false);
});

test.each(["unstaged", "staged", "committed", "untracked"])("nested declared checks refuse base credit for %s checkout dependency changes (#753)", async (state) => {
  const { root } = fixture();
  const scope = join(root, "component"); mkdirSync(scope);
  mkdirSync(join(root, "node_modules/dep"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules/\nresult.xml\n");
  writeFileSync(join(root, "package.json"), '{"dependencies":{"dep":"1.0.0"}}');
  writeFileSync(join(root, "node_modules/dep/index.js"), 'module.exports="old";');
  writeFileSync(join(scope, "local.test.js"), "// test fixture\n");
  writeFileSync(join(root, "check.cjs"), "const fs=require('fs');const fail=require('dep')!=='old';"
    + "fs.writeFileSync('result.xml','<testsuite tests=\"1\"><testcase name=\"dependency-behavior\">'"
    + "+(fail?'<failure/>':'')+'</testcase></testsuite>');process.exit(fail?1:0);");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "dependency base");
  const base = git("rev-parse", "HEAD");
  const dependency = state === "untracked" ? "package-lock.json" : "package.json";
  writeFileSync(join(root, dependency), '{"dependencies":{"dep":"2.0.0"}}');
  if (state === "staged" || state === "committed") git("add", dependency);
  if (state === "committed") git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "dependency update");
  writeFileSync(join(root, "node_modules/dep/index.js"), 'module.exports="new";');
  writeFileSync(join(scope, "local.test.js"), "// changed test fixture\n");
  approve(root);
  const selected = suggestChecks(scope);
  const [run] = await runCommands(scope, selected, ["local.test.js"], signal(), undefined, undefined, { base });
  expect(run?.origin?.cause).toBe("unknown");
  expect(run?.origin?.reason).toContain(dependency);
  const [exercised] = await exerciseTests(scope, base, ["local.test.js"], ["local.test.js"], selected, signal());
  expect(exercised?.sensitivity).toBe("unknown");
  expect(exercised?.reason).toContain(dependency);
});

test("linked reports cannot be read or cleared and linked execution folders cannot run (#753)", async () => {
  const { root } = fixture();
  const elsewhere = mkdtempSync(join(tmpdir(), "tesota-declared-outside-"));
  writeFileSync(join(elsewhere, "result.xml"), "untouched");
  symlinkSync(join(elsewhere, "result.xml"), join(root, "result.xml"), "file");
  approve(root);
  expect((await runCommands(root, suggestChecks(root), ["source.py"], signal()))[0]?.evidence.outcome).toBe("not_started");
  expect(readFileSync(join(elsewhere, "result.xml"), "utf8")).toBe("untouched");
  expect(existsSync(join(root, "ran"))).toBe(false);
  symlinkSync(elsewhere, join(root, "linked"), "junction");
  writeFileSync(join(root, ".tesota/checks.json"), '{"checks":[{"command":"node check.cjs","folder":"linked"}]}');
  approve(root);
  expect((await runCommands(root, suggestChecks(root), ["linked/source.py"], signal()))[0]?.evidence.outcome).toBe("not_started");
});
