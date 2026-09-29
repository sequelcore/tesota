import { check, type PathTranslation, releaseState, serve } from "./bubblewrap-sandbox.js";

/**
 * The WSL sandbox's process inside WSL (decision 043), which Tesota starts with
 * one of three commands: `serve` a workspace until its input ends, `check`
 * what the sandbox still needs, or `release` what a workspace kept. `--wsl`
 * says the host's paths are Windows paths.
 */
const [command, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
};
const paths: PathTranslation = rest.includes("--wsl") ? "wsl" : "linux";
const workspace = option("--workspace");
const cache = option("--cache");

if (command === "check") {
  process.stdout.write(`${JSON.stringify({ type: "checked", ...check(paths) })}\n`);
} else if (command === "serve" && workspace !== undefined) {
  await serve({ workspace, paths, ...cache === undefined ? {} : { cache } }, process.stdin, process.stdout).catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ type: "failed", message: error instanceof Error ? error.message : String(error) })}\n`);
  });
} else if (command === "release" && workspace !== undefined) {
  await releaseState(workspace, paths);
} else {
  process.stderr.write("Usage: bubblewrap-sandbox-server <check | serve --workspace <path> [--cache <path>] | release --workspace <path>> [--wsl]\n");
  process.exitCode = 2;
}
