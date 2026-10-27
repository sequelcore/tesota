import { homedir, tmpdir } from "node:os";

/**
 * The engine's tests run only inside `scripts/isolated.ts` (#479), which
 * gives them a home folder and a temporary folder of their own from the
 * start, so no test or process it spawns reads or writes the operator's
 * `~/.tesota`, `~/.pi` or Git configuration, and nothing is left behind.
 * Setting them here instead would miss every process a test spawns without
 * `env`, which Bun starts with the environment this process began with.
 */
const root = process.env["TESOTA_ISOLATED"];
// The Claude Code fake must be the runner's own, so no test reaches the real one (#680).
const claude = process.env["CLAUDE_CODE_EXECUTABLE"];
if (root === undefined || !homedir().startsWith(root) || !tmpdir().startsWith(root) || claude === undefined || !claude.startsWith(root)) {
  throw new Error("Run the engine's tests with `bun run test`, which gives them a home and temporary folder of their own (scripts/isolated.ts).");
}
