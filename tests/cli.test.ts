import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

function run(args: readonly string[], cwd?: string) {
  const result = spawnSync("bun", ["--no-env-file", entry, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000,
    maxBuffer: 64 * 1024,
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.error !== undefined) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}

it("publishes the compiled CLI through the canonical tesota executable", () => {
  const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  expect(manifest).toMatchObject({ bin: { tesota: "dist/cli.js" } });
  expect(readFileSync(entry, "utf8")).toMatch(/^#!\/usr\/bin\/env bun\r?\n/u);
});

it.each([[], ["--help"], ["-h"], ["help"]])("prints compiled CLI help for %j", (...args) => {
  const result = run(args);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "Tesota\nUsage: tesota [--help | -h | help]\n" +
    "       tesota verify <file.ts|file.js>\n" +
    "       tesota auth <login|status|logout>\n" +
    "       tesota candidate create\n" +
    "       tesota candidate inspect <candidate-id|candidate-directory>\n" +
    "       tesota candidate check typecheck <candidate-id|candidate-directory>\n" +
    "       tesota candidate list\n" +
    "       tesota candidate clean\n" +
    "       tesota candidate abandon <candidate-id|candidate-directory>\n" +
    "       tesota isolation qualify\n" +
    "       tesota task propose <request>\n" +
    "       tesota task start <proposal-id>\n" +
    "       tesota task outcome <proposal-id>\n" +
    "       tesota task run gentle-review <candidate-id|candidate-directory> <gentle-ai-executable> <lineage-id>\n" +
    "       tesota task review <candidate-id|candidate-directory>\n" +
    "       tesota task decide <candidate-id|candidate-directory> <accept|reject> <review-sha256>\n" +
    "       tesota task promote <candidate-id|candidate-directory> <review-sha256>\n\n" +
    "Runs bounded verification and scoped repository tasks.\n",
  );
});

it("does not approve a repository typecheck in a non-interactive process", () => {
  const result = run(["candidate", "check", "typecheck", "candidate"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Repository typecheck requires an interactive Windows terminal. Nothing changed.\n");
});

it.runIf(process.platform === "win32")("treats a repository without a committed baseline as unavailable", () => {
  const foreignRepository = mkdtempSync(join(tmpdir(), "tesota-cli-foreign-"));
  try {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: foreignRepository, encoding: "utf8", windowsHide: true, shell: false, timeout: 5000, env,
    });
    expect(initialized.status).toBe(0);
    const result = run(["task", "propose", "Explain this repository"], foreignRepository);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Repository discovery unavailable or failed; nothing changed and no authority was created.\n");
  } finally {
    rmSync(foreignRepository, { recursive: true, force: true });
  }
});

it.each([["--unknown"], ["run"], ["--help", "--unknown"], ["help", "extra"], ["candidate", "check"],
  ["candidate", "check", "typecheck"], ["candidate", "check", "unknown", "candidate"], ["task", "run", "gentle-review"],
  ["task", "propose"], ["task", "outcome"], ["task", "run", "unregistered"], ["task", "recover", "missing-candidate"]])(
  "rejects invalid compiled CLI arguments %j",
  (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid arguments. Use tesota --help.\n");
  },
);
