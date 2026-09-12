import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
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
    "       tesota candidate list\n" +
    "       tesota candidate clean\n" +
    "       tesota candidate abandon <candidate-id|candidate-directory>\n" +
    "       tesota task prepare <candidate-directory>\n" +
    "       tesota task check <candidate-directory>\n" +
    "       tesota task propose <request>\n" +
    "       tesota task run [task-id]\n" +
    "       tesota task recover <candidate-id|candidate-directory>\n" +
    "       tesota task run coding-agent\n" +
    "       tesota task run gentle-review <candidate-id|candidate-directory> <gentle-ai-executable> <lineage-id>\n" +
    "       tesota task review <candidate-id|candidate-directory>\n" +
    "       tesota task decide <candidate-id|candidate-directory> <accept|reject> <review-sha256>\n" +
    "       tesota task promote <candidate-id|candidate-directory> <review-sha256>\n\n" +
    "Runs bounded verification and scoped repository tasks.\n",
  );
});

it("reports an unsupported Git repository before inference", () => {
  const foreignRepository = mkdtempSync(join(tmpdir(), "tesota-cli-foreign-"));
  try {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: foreignRepository, encoding: "utf8", windowsHide: true, shell: false, timeout: 5000, env,
    });
    expect(initialized.status).toBe(0);
    const result = run(["task", "propose", "Explain this repository"], foreignRepository);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Live repository discovery currently supports only the Tesota repository root.\n");
  } finally {
    rmSync(foreignRepository, { recursive: true, force: true });
  }
});

it.each([["--unknown"], ["run"], ["--help", "--unknown"], ["help", "extra"], ["task", "run", "gentle-review"],
  ["task", "propose"]])(
  "rejects invalid compiled CLI arguments %j",
  (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid arguments. Use tesota --help.\n");
  },
);

it("rejects an unregistered task before candidate preparation", () => {
  const result = run(["task", "run", "unregistered"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Unknown task id.\n");
});

it("reports unavailable task recovery without treating it as a task ID", () => {
  const result = run(["task", "recover", "missing-candidate"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Task recovery unavailable. No predecessor state was changed.\n");
});
