import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { provideHost } from "../src/host.js";

/** Git for Windows' bash beside the `git` on the PATH, as the engine finds it (`shellHost`). */
const gitBash = (process.env["PATH"] ?? "").split(delimiter).map((folder) => join(folder, "git.exe")).filter((git) => existsSync(git))
  .flatMap((git) => [join(dirname(dirname(git)), "bin", "bash.exe"), join(dirname(dirname(git)), "usr", "bin", "bash.exe")])
  .find((bash) => existsSync(bash));

/**
 * The engine's parts as these tests run Tesota's verification without the
 * engine, which runs on Bun (#463): its version, its key for expanding
 * output, the POSIX shell the project's checks run in (Git's bash on
 * Windows, bash elsewhere), and work without a competing writer.
 */
provideHost({
  version: "0.1.0",
  keyText: (action) => action === "app.tools.expand" ? "ctrl+o" : action,
  // These tests exercise verification in one writer; the engine's snapshot tests exercise its OS lock on Bun.
  withLockWhile: (_path, work) => work(),
  shellConfig: () => ({ shell: process.platform === "win32" ? gitBash ?? "bash.exe" : "bash", args: ["-c"] }),
});
