#!/usr/bin/env bun

import { configuredOxlint, runOxlint } from "./verification/oxlint.js";

const help = `Tesota
Usage: tesota [--help | -h | help]
       tesota [--theme <tesota-dark|tesota-light|terminal>]
       tesota verify <file.ts|file.js>
       tesota auth <login|status|logout> [codex|anthropic|claude-code|openrouter|opencode]
       tesota models [<route> | <role> <route:model|default|off>]
       tesota prune [--force]
       tesota setup
       tesota sandbox [use <auto|native|docker|host> | clean]

Starts a coding session in the current repository. The agent works in a
separate copy; you review its changes and checks before anything is applied.
`;

const args = process.argv.slice(2);
const shellFlags = args.length === 0 || args.length === 2 && args[0] === "--theme";
if (shellFlags && process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true) {
  const { parseTesotaShellTheme } = await import("./tesota-shell-theme.js");
  const theme = args.length === 0 ? "tesota-dark" : parseTesotaShellTheme(args[1] ?? "");
  if (theme === undefined) {
    process.stderr.write("Choose a valid shell theme: tesota-dark, tesota-light or terminal.\n");
    process.exitCode = 2;
  } else {
    const { createProcessTesotaShell, runTesotaShellCommand } = await import("./tesota-shell-command.js");
    process.exit(await runTesotaShellCommand(createProcessTesotaShell(process.cwd(), theme)));
  }
} else if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0] ?? ""))) {
  process.stdout.write(help);
} else if ((args.length === 2 || args.length === 3) && args[0] === "auth" && args[1] !== undefined) {
  const { runAuthCommand } = await import("./auth.js");
  process.exit(await runAuthCommand(args[1], args[2]));
} else if (args[0] === "models") {
  const { runModelsCommand } = await import("./models-command.js");
  process.exitCode = runModelsCommand(args.slice(1), (text) => { process.stdout.write(text); });
} else if (args[0] === "prune" && (args.length === 1 || args.length === 2 && args[1] === "--force")) {
  const { formatPrunePlan, planWorkspacePrune, removeWorkspaces } = await import("./workspace-prune.js");
  const plan = await planWorkspacePrune();
  process.stdout.write(formatPrunePlan(plan));
  if (args[1] === "--force") {
    await removeWorkspaces(plan);
    process.stdout.write(`Removed ${plan.remove.length} workspaces.\n`);
  } else if (plan.remove.length > 0) {
    process.stdout.write("Nothing was removed. Run tesota prune --force to remove the listed workspaces.\n");
  }
} else if (args[0] === "sandbox") {
  const { runSandboxCommand } = await import("./sandbox-command.js");
  process.exitCode = await runSandboxCommand(args.slice(1), (text) => { process.stdout.write(text); });
} else if (args.length === 1 && args[0] === "setup") {
  const { runSetup, runSetupAction } = await import("./execution-providers.js");
  const { createInterface } = await import("node:readline/promises");
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  process.exitCode = await runSetup({ write: (text) => { process.stdout.write(text); }, run: runSetupAction,
    confirm: interactive ? async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { return /^(y|yes)?$/iu.test((await prompt.question(question)).trim()); } finally { prompt.close(); }
    } : null });
} else if (args.length === 2 && args[0] === "verify" && args[1] !== undefined) {
  const result = await runOxlint(configuredOxlint(process.cwd(), process.execPath), args[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "passed" ? 0 : result.status === "check_failed" ? 1 : 2;
} else {
  process.stderr.write("Invalid arguments. Use tesota --help.\n");
  process.exitCode = 2;
}
