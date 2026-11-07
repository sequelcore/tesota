/**
 * tla-ts's TLC-compatible command with `args`, run from inside this
 * process: the command a binary answers as `tesota __tla-ts`, since it embeds
 * tla-ts rather than finding it on disk, and the model check runs it as its
 * own process (`model-check.ts`). `runCli` reads its arguments from
 * `process.argv` and sets the process's exit code itself.
 */
export async function runTlaTs(args: readonly string[]): Promise<void> {
  process.argv = [process.argv[0] ?? "", "tla-ts", ...args];
  // @ts-expect-error -- tla-ts ships its command runner without types; Tesota's patch exports it only to run.
  const { runCli } = await import("tla-ts/run") as { runCli: () => Promise<void> };
  await runCli();
}
