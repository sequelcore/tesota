#!/usr/bin/env bun

import { configuredOxlint, runOxlint } from "./verification/oxlint.js";
import { TESOTA_SHELL_THEME_NAMES } from "./verification/shell-theme-rule.js";

const help = `Tesota
Usage: tesota [--help | -h | help]
       tesota [--theme <${TESOTA_SHELL_THEME_NAMES.join("|")}>]
       tesota resume [<session-id>] [--theme <${TESOTA_SHELL_THEME_NAMES.join("|")}>]
       tesota verify <file.ts|file.js>
       tesota auth <login|status|logout> [codex|anthropic|claude-code|openrouter|opencode|typesafe]
       tesota models [<route>]
       tesota roles [<role> [<route:model|default|off>]]
       tesota prune [--force]
       tesota recover [undo|finish|resolved [<id>]]
       tesota setup
       tesota sandbox [use [<auto|native|docker|host>] | clean]

Starts a new coding session in the current repository. The agent works in a
separate copy; you review its changes and checks before anything is applied.
`;

const args = process.argv.slice(2);
const resuming = args[0] === "resume";
const shellArgs = resuming ? args.slice(1) : args;
const themed = shellArgs.length >= 2 && shellArgs.at(-2) === "--theme";
const sessionArgs = themed ? shellArgs.slice(0, -2) : shellArgs;
const shellFlags = resuming ? sessionArgs.length <= 1 && (sessionArgs[0] === undefined || !sessionArgs[0].startsWith("-"))
  : sessionArgs.length === 0;
if (shellFlags && process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true) {
  const { parseTesotaShellTheme } = await import("./tesota-shell-theme.js");
  const theme = themed ? parseTesotaShellTheme(shellArgs.at(-1) ?? "") : "tesota-dark";
  if (theme === undefined) {
    process.stderr.write(`Choose a valid shell theme: ${TESOTA_SHELL_THEME_NAMES.join(", ")}.\n`);
    process.exitCode = 2;
  } else {
    // A plain folder is worked on only after the person agrees, once (decision 032).
    const { folderProblem, folderQuestion, isGitRepository, trackingDirectory } = await import("./folder-source.js");
    const { existsSync, realpathSync } = await import("node:fs");
    const cwd = realpathSync(process.cwd());
    const problem = isGitRepository(cwd) ? undefined : folderProblem(cwd);
    if (problem !== undefined) {
      process.stderr.write(`${problem}: run tesota in the folder of the work you want done.\n`);
      process.exit(2);
    }
    if (!resuming && !isGitRepository(cwd) && !existsSync(trackingDirectory(cwd))) {
      const { createInterface } = await import("node:readline/promises");
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await reader.question(await folderQuestion(cwd))).trim().toLowerCase();
      reader.close();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("Nothing was copied.\n");
        process.exit(0);
      }
    }
    let sessionId = sessionArgs[0];
    if (resuming && sessionId === undefined) {
      const { chooseCliOption } = await import("./cli-choice.js");
      const { openShellSessionStore } = await import("./shell-session-store.js");
      const store = openShellSessionStore(cwd);
      const sessions = store.list().toReversed();
      store.close();
      if (sessions.length === 0) {
        process.stderr.write("No saved sessions in this workspace. Run tesota to start one.\n");
        process.exit(1);
      }
      sessionId = await chooseCliOption("Saved sessions", sessions.map((session) => ({
        value: session.id, label: session.title, detail: session.id,
      })));
      if (sessionId === undefined) process.exit(0);
    }
    const { createProcessTesotaShell, runTesotaShellCommand } = await import("./tesota-shell-command.js");
    try {
      process.exit(await runTesotaShellCommand(createProcessTesotaShell(cwd, theme, undefined, sessionId)));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "Could not open the session."}\n`);
      process.exit(1);
    }
  }
} else if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0] ?? ""))) {
  process.stdout.write(help);
} else if ((args.length === 2 || args.length === 3) && args[0] === "auth" && args[1] !== undefined) {
  const { AUTH_ROUTES, runAuthCommand } = await import("./auth.js");
  let route = args[2];
  if (route === undefined && ["login", "logout"].includes(args[1]) && process.stdin.isTTY && process.stdout.isTTY) {
    const { chooseCliOption } = await import("./cli-choice.js");
    route = await chooseCliOption(`${args[1]} route`, AUTH_ROUTES.map((value) => ({ value, label: value })));
    if (route === undefined) process.exit(0);
  }
  if (route === undefined && ["login", "logout"].includes(args[1])) {
    process.stderr.write("Choose an auth route in a terminal, or pass one explicitly.\n");
    process.exit(2);
  }
  process.exit(await runAuthCommand(args[1], route));
} else if (args[0] === "models") {
  const { runModelsCommand } = await import("./models-command.js");
  process.exitCode = runModelsCommand(args.slice(1), (text) => { process.stdout.write(text); });
} else if (args[0] === "roles") {
  const { offeredModels, rolePicker, runRolesCommand } = await import("./models-command.js");
  const { isModelRole } = await import("./model-roles.js");
  let roleArgs = args.slice(1);
  if (roleArgs.length === 1 && isModelRole(roleArgs[0] ?? "") && process.stdin.isTTY && process.stdout.isTTY) {
    const { chooseCliOption } = await import("./cli-choice.js");
    const role = roleArgs[0] ?? "";
    const picker = rolePicker(`/roles ${role} `, offeredModels());
    const entries = picker?.entries.flatMap((entry) => [entry.id,
      ...entry.reasoning.map((level) => `${entry.id}@${level}`)].map((value) => ({
      value, label: value, detail: `${value === picker.current ? "current · " : ""}${entry.detail}`,
    }))) ?? [];
    const choice = await chooseCliOption(`${role} model`, entries);
    if (choice === undefined) process.exit(0);
    roleArgs = [role, choice];
  }
  process.exitCode = runRolesCommand(roleArgs, (text) => { process.stdout.write(text); });
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
} else if (args[0] === "recover") {
  const { realpathSync } = await import("node:fs");
  const { runRecoverCommand } = await import("./recover-command.js");
  process.exitCode = await runRecoverCommand(args.slice(1), realpathSync(process.cwd()), (text) => { process.stdout.write(text); });
} else if (args[0] === "sandbox") {
  const { runSandboxCommand } = await import("./sandbox-command.js");
  let sandboxArgs = args.slice(1);
  if (sandboxArgs.length === 1 && sandboxArgs[0] === "use" && process.stdin.isTTY && process.stdout.isTTY) {
    const { chooseCliOption } = await import("./cli-choice.js");
    const { SANDBOX_PREFERENCES } = await import("./execution-providers.js");
    await runSandboxCommand([], (text) => { process.stdout.write(text); });
    const choice = await chooseCliOption("New sessions use", SANDBOX_PREFERENCES.map((value) => ({
      value, label: value,
    })));
    if (choice === undefined) process.exit(0);
    sandboxArgs = ["use", choice];
  }
  process.exitCode = await runSandboxCommand(sandboxArgs, (text) => { process.stdout.write(text); });
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
