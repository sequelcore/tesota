#!/usr/bin/env bun
import manifest from "../package.json" with { type: "json" };

/**
 * The `tesota` command. It answers `--version` before loading anything
 * else, so startup stays within its budget as the engine grows; each other
 * command loads only what it needs. With no argument it opens the shell in
 * the current folder (#444); `-p` runs one request without it, and
 * `receipt` writes the last receipt for a pull request (#463), and
 * `accounts` adds, lists and removes the operator's accounts (#642). The
 * `--measure-*` commands are what the budget check runs, and `__lsc` is
 * LemmaScript for the verifier in a binary (`lsc.ts`).
 */

/** The verifier's flags (`gate.ts`), taken wherever they come, for the shell and `-p`. */
const verifierFlags = new Set(["claimcheck-model", "open-cases-model"]);

/** One command list for help and argument errors; internal entry points stay out of it. */
const usage: readonly (readonly [string, string] | string)[] = [
  ["tesota", "Open the shell in the current folder."],
  ["tesota -p, --print \"<request>\"", "Run one request without the shell."],
  ["  -c, --continue", "Continue this folder's latest session."],
  ["  -r, --resume <session>", "Continue the session with this id."],
  ["  --model <provider>/<id>", "Choose the model for this run."],
  ["tesota receipt [--json] [--owner <who>]", "Write the last run's receipt."],
  ["tesota doctor [--json]", "Report local tools and sign-ins without changing anything."],
  ["tesota accounts", "List your accounts."],
  ["tesota accounts add <provider> <name>", "Sign in and add an account (claude-code or openai-codex)."],
  ["tesota accounts login <provider>@<name>", "Sign an account in again."],
  ["tesota accounts remove <provider>@<name>", "Remove an account no session uses."],
  ["tesota graph --plain|--html <manifest>", "Print a captured model graph, or write its HTML page."],
  ["tesota --version", "Print the version."],
  ["tesota --help, -h", "Print this help."],
  "",
  "The shell and -p also take:",
  ["  --open-cases-model <provider>/<id>|off", "Choose the open-cases model, or turn it off."],
  ["  --claimcheck-model <provider>/<id>", "Choose the model that restates contracts."],
];
const column = Math.max(...usage.map((row) => typeof row === "string" ? 0 : row[0].length)) + 2;
const commands = usage.map((row) => typeof row === "string" ? row && `  ${row}` : `  ${row[0].padEnd(column)}${row[1]}`).join("\n");
const documentation = "Docs: https://github.com/sequelcore/tesota/tree/main/docs";

/** `args` without the verifier's flags, and their values by name. */
function splitFlags(args: readonly string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    const [name = "", value] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/su) : [];
    if (!verifierFlags.has(name)) rest.push(arg);
    else if (value !== undefined) flags[name] = value;
    else if (args[at + 1] !== undefined) flags[name] = args[++at] ?? "";
    else rest.push(arg);
  }
  return { flags, rest };
}

const { flags, rest: args } = splitFlags(process.argv.slice(2));
const [command, ...rest] = args;
const output = { out: (text: string) => { process.stdout.write(text); }, error: (text: string) => { process.stderr.write(text); } };

/** Runs `work`, then exits with its code, or 1 when it throws, saying why. */
function exitWith(work: Promise<number | void>): void {
  work.then((code) => { process.exit(code ?? 0); }, (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

if (command === "--version") console.log(manifest.version);
else if (command === "--help" || command === "-h") {
  exitWith(import("../../../src/welcome-header.ts").then(({ WELCOME_TAGLINE }) => {
    console.log(`${WELCOME_TAGLINE}\n\n${commands}\n\n${documentation}`);
  }));
}
else if (command === undefined) exitWith(import("./shell/app.ts").then(({ runApp }) => runApp({ cwd: process.cwd(), flags })));
else if (command === "-p" || command === "--print") {
  exitWith(import("./print.ts").then(({ runPrint }) => runPrint(rest, process.cwd(), output, flags)));
}
else if (command === "doctor") exitWith(import("./doctor.ts").then(({ doctorCommand }) => doctorCommand(rest, output)));
else if (command === "accounts") exitWith(import("./accounts.ts").then(({ accountsCommand }) => accountsCommand(rest, output)));
else if (command === "receipt") {
  exitWith(Promise.all([import("../../../src/pull-request-receipt.ts"), import("./session-store.ts")])
    .then(([{ receiptCommand }, { sessionStore }]) => receiptCommand(rest, process.cwd(), sessionStore, output)));
}
else if (command === "--measure-loop" || command === "--measure-resume") {
  import("./measure.ts").then((measure) => command === "--measure-loop" ? measure.measureLoop() : measure.measureResume())
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
else if (command === "--measure-shell") exitWith(import("./shell/measure-shell.ts").then(({ measureShell }) => measureShell()));
else if (command === "graph") exitWith(import("../../../src/model-view-process.ts").then(({ modelViewCommand }) => modelViewCommand(rest)));
else if (command === "__model-view") exitWith(import("../../../src/model-view-worker.ts").then(({ modelViewWorker }) => modelViewWorker()));
else if (command === "__lsc") {
  import("./lsc.ts").then(({ runLsc }) => runLsc(rest)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
else {
  console.error(`Unknown argument ${command}. Use:\n${commands}\n\n${documentation}`);
  process.exitCode = 2;
}
