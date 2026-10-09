#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedPi, minimumPiVersion, missingExtensions, piModule, piOnPath, piProblem, piThemeSetting, themeArguments }
  from "./pi-install.js";
import { type PiSessions, receiptCommand } from "./pull-request-receipt.js";

/**
 * The `tesota` command: Pi with Tesota's package loaded, every argument
 * passed through to Pi, in Tesota's theme for the run unless the operator
 * chose one (`themeArguments`). The Pi installed beside Tesota comes first,
 * then the one on PATH. `tesota receipt` instead writes the last receipt for a pull
 * request, read from that Pi's sessions (`receiptCommand`).
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const missing = missingExtensions(packageRoot);
if (missing.length > 0) {
  process.stderr.write(`Tesota's installation is incomplete: its Pi extension is missing (${missing.join(", ")}). ` +
    "Reinstall Tesota.\n");
  process.exit(1);
}
const pi = installedPi(packageRoot) ?? piOnPath(process.env["PATH"] ?? "", process.platform);
const problem = piProblem(pi, minimumPiVersion(packageRoot));
if (pi === undefined || problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

if (process.argv[2] === "receipt") {
  const { SessionManager } = await import(pathToFileURL(piModule(pi)).href) as { SessionManager: PiSessions };
  process.exit(await receiptCommand(process.argv.slice(3), process.cwd(), SessionManager,
    { out: (text) => process.stdout.write(text), error: (text) => process.stderr.write(text) }));
}

const args = process.argv.slice(2);
const theme = themeArguments(await piThemeSetting(pi, process.cwd()), args);
const child = spawn(process.execPath, [pi.cli, "--extension", packageRoot, ...theme, ...args], { stdio: "inherit" });
// Pi owns the terminal: Ctrl+C reaches it directly, and Tesota waits for it to exit.
process.on("SIGINT", () => undefined);
child.on("error", (error) => {
  process.stderr.write(`Tesota could not start Pi: ${error.message}\n`);
  process.exit(1);
});
// A Pi ended by a signal exits as a shell reports it: 128 plus the signal's number.
child.on("exit", (code, signal) => process.exit(code ?? 128 + (signal === null ? 0 : constants.signals[signal])));
