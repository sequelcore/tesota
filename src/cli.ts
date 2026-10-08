#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPi, minimumPiVersion, piOnPath, piProblem } from "./pi-install.js";

/**
 * The `tesota` command: Pi with Tesota's package loaded, every argument
 * passed through to Pi. The Pi installed beside Tesota comes first, then the
 * one on PATH.
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pi = installedPi(packageRoot) ?? piOnPath(process.env["PATH"] ?? "", process.platform);
const problem = piProblem(pi, minimumPiVersion(packageRoot));
if (pi === undefined || problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [pi.cli, "--extension", packageRoot, ...process.argv.slice(2)], { stdio: "inherit" });
// Pi owns the terminal: Ctrl+C reaches it directly, and Tesota waits for it to exit.
process.on("SIGINT", () => undefined);
child.on("error", (error) => {
  process.stderr.write(`Tesota could not start Pi: ${error.message}\n`);
  process.exit(1);
});
// A Pi ended by a signal exits as a shell reports it: 128 plus the signal's number.
child.on("exit", (code, signal) => process.exit(code ?? 128 + (signal === null ? 0 : constants.signals[signal])));
