import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
// By its real name, as a session names its folder: Windows CI's temporary folder is spelled RUNNER~1, macOS's is a link.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tesota-core-isolated-")));
const [home, temporary] = [root, join(root, "tmp")];
let code = 1;
try {
  mkdirSync(temporary);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const claude = join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  // A native fake works for execFile and the SDK on Windows too. PATH covers
  // callers using `claude`; the override precedes the SDK's bundled executable.
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../tests/fixtures/claude-code/forbidden.ts")],
    compile: { outfile: claude } });
  if (!build.success) throw new Error(`Could not build the Claude test fake: ${build.logs.join("\n")}`);
  // Windows may inherit `Path`. Do not emit both it and `PATH`: Bun can
  // preserve the original entry rather than the one with our fake prepended.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !(process.platform === "win32" && /^path$/iu.test(name))
    && !/^(?:ANTHROPIC_|CLAUDE_|USE_(?:LOCAL|STAGING)_OAUTH$)/iu.test(name)));
  code = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"], env: { ...inherited, TESOTA_ISOLATED: root,
    CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_CODE_EXECUTABLE: claude,
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}`,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMPDIR: temporary, TEMP: temporary, TMP: temporary } }).exitCode ?? 1;
} finally {
  // Longer than a test's own cleanup: a binary a test built may still be held by Windows for a while (#593).
  rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
}
process.exit(code);
