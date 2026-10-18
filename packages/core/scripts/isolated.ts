import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs a command with a home folder and a temporary folder of its own,
 * removed when it ends, so the engine's tests and budget never read or write
 * the operator's `~/.tesota`, `~/.pi` or Git configuration, and leave nothing
 * in the temporary folder (#479). The temporary folder is inside the home,
 * as Windows keeps it, so a test's folder stays short where the shell shows
 * it under `~`. Both are set before the command starts, because Bun gives a
 * process it spawns without `env` the environment it started with, not
 * `process.env` as changed since. Exits with the command's code;
 * `TESOTA_ISOLATED` names the folder, which the tests' preload checks.
 */
const command = process.argv.slice(2);
if (command.length === 0) throw new Error("Usage: bun scripts/isolated.ts <command> [args...]");
const root = mkdtempSync(join(tmpdir(), "tesota-core-isolated-"));
const [home, temporary] = [root, join(root, "tmp")];
mkdirSync(temporary);
let code = 1;
try {
  code = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, TESOTA_ISOLATED: root,
    HOME: home, USERPROFILE: home, TMPDIR: temporary, TEMP: temporary, TMP: temporary } }).exitCode ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(code);
