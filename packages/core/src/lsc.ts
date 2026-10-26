import manifest from "lemmascript/package.json" with { type: "json" };

/**
 * LemmaScript's `lsc` with `args`, run from inside this process: the command
 * a binary answers as `tesota __lsc`, since it embeds LemmaScript rather than
 * finding it on disk, and the verifier runs it as its own process
 * (`lemmascript-verifier.ts`, #472). `lsc` reads its arguments from
 * `process.argv` as it loads, and sets the process's exit code itself.
 */
export async function runLsc(args: readonly string[]): Promise<void> {
  // The upstream version command reads package.json by a disk path, absent inside a compiled binary.
  if (args[0] === "version") {
    console.log(manifest.version);
    return;
  }
  process.argv = [process.argv[0] ?? "", "lsc", ...args];
  // @ts-expect-error -- LemmaScript ships its command without types; it is loaded only to run.
  await import("lemmascript/tools/dist/lsc.js");
}
