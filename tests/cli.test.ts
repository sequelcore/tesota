import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}
// Each process takes about half a second, but a busy Windows runner has taken ten times that; a hang still fails.
const processLimitMs = 30_000;
vi.setConfig({ testTimeout: processLimitMs + 5_000 });

function run(args: readonly string[]) {
  const result = spawnSync("bun", ["--no-env-file", entry, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: processLimitMs,
    maxBuffer: 64 * 1024,
    env,
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
    "       tesota [--theme <tesota-dark|tesota-light|vesper|sequel|automata|phosphor|terminal>]\n" +
    "       tesota resume [<session-id>] [--theme <tesota-dark|tesota-light|vesper|sequel|automata|phosphor|terminal>]\n" +
    "       tesota run [--allow-commands] [--allow-network] [--checks=<command;…>|none] [--apply] [--folder] [--json] (<request> | -)\n" +
    "       tesota verify <file.ts|file.js>\n" +
    "       tesota auth <login|status|logout> [chatgpt|anthropic|claude-code|openrouter|opencode|typesafe|<added route>]\n" +
    "       tesota auth status --show-accounts\n" +
    "       tesota auth remove <added route>\n" +
    "       tesota auth login <chatgpt|claude-code> --as <name>\n" +
    "       tesota models [<route>]\n" +
    "       tesota usage [<route>]\n" +
    "       tesota roles [<role> [<route:model|default|off>]]\n" +
    "       tesota prune [--force]\n" +
    "       tesota recover [undo|finish|resolved [<id>]]\n" +
    "       tesota setup\n" +
    "       tesota sandbox [use [<auto|wsl|docker|host>] | clean]\n\n" +
    "Starts a new coding session in the current repository. The agent works in\n" +
    "your files and each turn is checked and reviewed; you keep or revert it. A\n" +
    "plain folder, or a session you isolate, works in a copy you apply from.\n" +
    "tesota run does one request without the shell, allowing only what its flags\n" +
    "say, and leaves the session to resume.\n",
  );
});

it.each([["--unknown"], ["--help", "--unknown"], ["help", "extra"], ["--theme"], ["--execution", "host-local"],
  ["task", "propose", "Explain"], ["candidate", "list"], ["isolation", "qualify"], ["prune", "--all"]])(
  "rejects invalid compiled CLI arguments %j",
  (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid arguments. Use tesota --help.\n");
  },
);

it.each([[["run"], "Give the request"], [["run", "--yes", "Fix it"], "Unknown option --yes"]])(
  "refuses a compiled run without a request or with an unknown option: %j",
  (args, message) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  },
);

it.each([["login"], ["logout"]])("requires an explicit auth route without a terminal for %j", (action) => {
  const result = run(["auth", action]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Choose an auth route in a terminal, or pass one explicitly.\n");
});

it("does not accept role assignments through the model catalog command", () => {
  const result = run(["models", "agent", "chatgpt:gpt-6-luna"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("Usage: tesota models [<");
});
