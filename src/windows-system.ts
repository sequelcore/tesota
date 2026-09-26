import { isAbsolute, resolve } from "node:path";

/**
 * Windows' own programs, by their place in the system directory. Tesota never
 * lets PATH choose them: Git Bash, for one, puts its own `whoami` first, and a
 * repository or tool directory on PATH could supply any program by name.
 */

/** `%SystemRoot%\System32`, from the process environment. */
export function windowsSystemDirectory(): string {
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined || !isAbsolute(systemRoot)) throw new Error("Cannot locate Windows system directory");
  return resolve(systemRoot, "System32");
}

/** A program under the system directory, such as `whoami.exe`. */
export function windowsSystemProgram(path: string): string {
  return resolve(windowsSystemDirectory(), path);
}

/** Windows PowerShell 5.1, which every supported Windows version includes. */
export function windowsPowerShell(): string {
  return windowsSystemProgram("WindowsPowerShell\\v1.0\\powershell.exe");
}
