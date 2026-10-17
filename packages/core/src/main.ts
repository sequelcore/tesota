#!/usr/bin/env bun
import manifest from "../package.json" with { type: "json" };

/**
 * The `tesota` command. It answers `--version` before loading anything
 * else, so startup stays within its budget as the engine grows; each other
 * command loads only what it needs. With no argument it opens the shell in
 * the current folder (#444); `-p` runs one request without it, and
 * `receipt` writes the last receipt for a pull request (#463). The
 * `--measure-*` commands are what the budget check runs.
 */
const [command, ...rest] = process.argv.slice(2);
const output = { out: (text: string) => { process.stdout.write(text); }, error: (text: string) => { process.stderr.write(text); } };

/** Runs `work`, then exits with its code, or 1 when it throws, saying why. */
function exitWith(work: Promise<number | void>): void {
  work.then((code) => { process.exit(code ?? 0); }, (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

if (command === "--version") console.log(manifest.version);
else if (command === undefined) exitWith(import("./shell/app.ts").then(({ runApp }) => runApp({ cwd: process.cwd() })));
else if (command === "-p" || command === "--print") exitWith(import("./print.ts").then(({ runPrint }) => runPrint(rest, process.cwd(), output)));
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
else {
  console.error(`Unknown argument ${command}. Use: tesota (the shell), tesota -p "<request>", tesota receipt [--json], tesota --version.`);
  process.exitCode = 2;
}
