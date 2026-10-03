import { check, type PathTranslation, releaseRepository, releaseState, serve, stateSize } from "./bubblewrap-sandbox.js";

/**
 * The WSL sandbox's process inside WSL (decision 043), which Tesota starts with
 * one of four commands: `serve` a workspace, with the folders of its
 * JavaScript packages, until its input ends, `check`
 * what the sandbox still needs, `size` what a workspace keeps, in bytes, or
 * `release` what a workspace kept, or a repository's package caches and
 * installed tools, named by its key. `--wsl`
 * says the host's paths are Windows paths.
 */
const [command, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
};
const paths: PathTranslation = rest.includes("--wsl") ? "wsl" : "linux";
const workspace = option("--workspace");
const repository = option("--repository");
const packages = rest.flatMap((value, index) => rest[index - 1] === "--package" ? [value] : []);

if (command === "check") {
  process.stdout.write(`${JSON.stringify({ type: "checked", ...check(paths) })}\n`);
} else if (command === "serve" && workspace !== undefined) {
  await serve({ workspace, paths, packages, ...repository === undefined ? {} : { repository } }, process.stdin, process.stdout).catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ type: "failed", message: error instanceof Error ? error.message : String(error) })}\n`);
  });
} else if (command === "size" && workspace !== undefined) {
  process.stdout.write(`${await stateSize(workspace, paths)}\n`);
} else if (command === "release" && workspace !== undefined) {
  await releaseState(workspace, paths);
} else if (command === "release" && repository !== undefined) {
  await releaseRepository(repository);
} else {
  process.stderr.write("Usage: bubblewrap-sandbox-server <check | serve --workspace <path> [--repository <key>] [--package <folder>]... | " +
    "size --workspace <path> | release <--workspace <path> | --repository <key>>> [--wsl]\n");
  process.exitCode = 2;
}
