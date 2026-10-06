#!/usr/bin/env bun

import { configuredOxlint, runOxlint } from "./verification/oxlint.js";
import { TESOTA_SHELL_THEME_NAMES } from "./verification/shell-theme-rule.js";

const help = `Tesota
Usage: tesota [--help | -h | help]
       tesota [--theme <${TESOTA_SHELL_THEME_NAMES.join("|")}>]
       tesota resume [<session-id>] [--theme <${TESOTA_SHELL_THEME_NAMES.join("|")}>]
       tesota run [--allow-commands] [--allow-network] [--checks=<command;…>|none] [--apply] [--folder] [--json] (<request> | -)
       tesota verify <file.ts|file.js>
       tesota auth <login|status|logout> [codex|anthropic|claude-code|openrouter|opencode|typesafe|<added route>]
       tesota auth status --show-accounts
       tesota auth remove <added route>
       tesota auth login <codex|claude-code> --as <name>
       tesota models [<route>]
       tesota usage [<route>]
       tesota roles [<role> [<route:model|default|off>]]
       tesota prune [--force]
       tesota recover [undo|finish|resolved [<id>]]
       tesota setup
       tesota sandbox [use [<auto|wsl|docker|host>] | clean]

Starts a new coding session in the current repository. The agent works in
your files and each turn is checked and reviewed; you keep or revert it. A
plain folder, or a session you isolate, works in a copy you apply from.
tesota run does one request without the shell, allowing only what its flags
say, and leaves the session to resume.
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
    // A plain folder is recorded only after the person agrees, once; a repository's .gitignore already says what is its work.
    const { folderQuestion, isGitRepository, shadowDirectory, sourceProblem, sourceRoot } = await import("./source-shadow.js");
    const { existsSync, realpathSync } = await import("node:fs");
    const cwd = realpathSync(process.cwd());
    const kind = isGitRepository(cwd) ? "repository" : "folder";
    const source = await sourceRoot(cwd, kind);
    const problem = sourceProblem(source);
    if (problem !== undefined) {
      process.stderr.write(`${problem}: run tesota in the folder of the work you want done.\n`);
      process.exit(2);
    }
    if (!resuming && kind === "folder" && !existsSync(shadowDirectory(source))) {
      const { createInterface } = await import("node:readline/promises");
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await reader.question(await folderQuestion(source))).trim().toLowerCase();
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
} else if (args.length === 5 && args[0] === "auth" && args[1] === "login" && args[3] === "--as" && args[2] !== undefined &&
  args[4] !== undefined) {
  // Another account of a kind, as a route of its own (decision 050).
  const { addAccount } = await import("./auth.js");
  process.exit(await addAccount(args[2], args[4]));
} else if ((args.length === 2 || args.length === 3) && args[0] === "auth" && args[1] !== undefined) {
  const { AUTH_ROUTES, runAuthCommand } = await import("./auth.js");
  let route = args[2];
  if (route === undefined && ["login", "logout"].includes(args[1]) && process.stdin.isTTY && process.stdout.isTTY) {
    const { chooseCliOption } = await import("./cli-choice.js");
    route = await chooseCliOption(`${args[1]} route`, AUTH_ROUTES.map((value) => ({ value, label: value })));
    if (route === undefined) process.exit(0);
  }
  if (route === undefined && args[1] === "remove") {
    process.stderr.write("Name the added route to remove: tesota auth remove <route>.\n");
    process.exit(2);
  }
  if (route === undefined && ["login", "logout"].includes(args[1])) {
    process.stderr.write("Choose an auth route in a terminal, or pass one explicitly.\n");
    process.exit(2);
  }
  process.exit(await runAuthCommand(args[1], route));
} else if (args[0] === "run") {
  const { parseRunArgs, runInDirectory } = await import("./run-command.js");
  const parsed = parseRunArgs(args.slice(1));
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    process.exit(2);
  }
  const { existsSync, realpathSync } = await import("node:fs");
  const { isGitRepository, shadowDirectory, sourceProblem, sourceRoot } = await import("./source-shadow.js");
  const cwd = realpathSync(process.cwd());
  const kind = isGitRepository(cwd) ? "repository" : "folder";
  const source = await sourceRoot(cwd, kind);
  const problem = sourceProblem(source);
  if (problem !== undefined) {
    process.stderr.write(`${problem}: run tesota in the folder of the work you want done.\n`);
    process.exit(2);
  }
  // The shell asks once before recording a plain folder; a run has nobody to ask, so it needs the flag.
  if (kind === "folder" && !existsSync(shadowDirectory(source)) && !parsed.folder) {
    process.stderr.write("This folder is not a Git repository. Pass --folder to let Tesota keep a copy of it, as the shell " +
      "asks once.\n");
    process.exit(2);
  }
  let request = parsed.request;
  if (request === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    request = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (request.length === 0) {
    process.stderr.write("The request read from standard input is empty.\n");
    process.exit(2);
  }
  process.exitCode = await runInDirectory(cwd, { ...parsed, request }, {
    out: (text) => { process.stdout.write(text); },
    err: (text) => { process.stderr.write(text); },
  });
} else if (args[0] === "models") {
  const { offeredModels, runModelsCommand } = await import("./models-command.js");
  const { allRoutes, routeAccounts } = await import("./auth.js");
  process.exitCode = runModelsCommand(args.slice(1), (text) => { process.stdout.write(text); }, offeredModels(),
    await routeAccounts(allRoutes()));
} else if (args[0] === "usage") {
  const { runUsageCommand } = await import("./account-usage.js");
  const { usageSources } = await import("./integrations/usage-sources.js");
  process.exitCode = await runUsageCommand(args.slice(1), (text) => { process.stdout.write(text); }, usageSources());
} else if (args[0] === "roles") {
  const { offeredModels, rolePicker, runRolesCommand, servedModels } = await import("./models-command.js");
  const { DEFAULT_MODELS_FILE, isModelRole } = await import("./model-roles.js");
  const { allRoutes, routeAccounts } = await import("./auth.js");
  const accounts = await routeAccounts(allRoutes());
  let roleArgs = args.slice(1);
  if (roleArgs.length === 1 && isModelRole(roleArgs[0] ?? "") && process.stdin.isTTY && process.stdout.isTTY) {
    const { chooseCliOption } = await import("./cli-choice.js");
    const role = roleArgs[0] ?? "";
    const picker = rolePicker(`/roles ${role} `, servedModels(offeredModels(), accounts));
    const entries = picker?.entries.flatMap((entry) => [entry.id,
      ...entry.reasoning.map((level) => `${entry.id}@${level}`)].map((value) => ({
      value, label: value, detail: `${value === picker.current ? "current · " : ""}${entry.detail}`,
    }))) ?? [];
    const choice = await chooseCliOption(`${role} model`, entries);
    if (choice === undefined) process.exit(0);
    roleArgs = [role, choice];
  }
  process.exitCode = runRolesCommand(roleArgs, (text) => { process.stdout.write(text); }, offeredModels(), DEFAULT_MODELS_FILE,
    accounts);
} else if (args[0] === "prune" && (args.length === 1 || args.length === 2 && args[1] === "--force")) {
  const { formatPrunePlan, measureWorkspaces, planWorkspacePrune, removeWorkspaces } = await import("./workspace-prune.js");
  const { claudeCodeConfigDirectories } = await import("./claude-code-transcripts.js");
  // Claude Code's folders are read only here, never by default, so nothing else scans the operator's own.
  const plan = await planWorkspacePrune(undefined, undefined, undefined, undefined, claudeCodeConfigDirectories());
  process.stdout.write(formatPrunePlan(plan, await measureWorkspaces(plan)));
  if (args[1] === "--force") {
    await removeWorkspaces(plan);
    process.stdout.write(`Removed ${plan.remove.length} workspaces, ${plan.sessions.length} session records and ` +
      `${plan.shadows.length} shadow repositories.\n`);
  } else if (plan.remove.length + plan.sessions.length + plan.shadows.length > 0) {
    process.stdout.write("Nothing was removed. Run tesota prune --force to remove what is listed.\n");
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
