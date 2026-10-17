import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The `tesota` binary (#472), as the budget measures it and a release would
 * ship it: `bun build --compile` of the engine, which embeds LemmaScript and
 * the TypeScript parser as code, and at the binary's root the files
 * verification reads beside its code: tree-sitter's runtime and each grammar
 * in `grammars/` (`grammar-source.ts`, `binary.ts`). Run as a script, it
 * builds one binary per target into the folder it is given.
 */

const repository = join(import.meta.dir, "..", "..", "..");
const engine = join(import.meta.dir, "..", "src", "main.ts");

/** What a binary embeds beside its code, each at the binary's root under its own name. */
function embedded(): string[] {
  const grammars = join(repository, "grammars");
  return [join(repository, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
    ...readdirSync(grammars).filter((name) => name.endsWith(".wasm")).map((name) => join(grammars, name))];
}

/**
 * The systems a release builds for, as OpenCode's: Linux with glibc and with
 * musl, macOS and Windows, each on x64 and arm64, and the x64 builds again
 * without AVX2 ("baseline") for older processors.
 */
export const targets = [
  "bun-linux-x64", "bun-linux-x64-baseline", "bun-linux-arm64",
  "bun-linux-x64-musl", "bun-linux-x64-musl-baseline", "bun-linux-arm64-musl",
  "bun-darwin-arm64", "bun-darwin-x64", "bun-darwin-x64-baseline",
  "bun-windows-x64", "bun-windows-x64-baseline", "bun-windows-arm64",
] as const;

/** Compiles `entry`, the engine unless given, into `outfile`, for `target` or this system. */
export function build(outfile: string, options: { readonly target?: string; readonly entry?: string } = {}): void {
  // Splitting keeps the loop in its own chunk, loaded only when used: without it every start parsed the whole
  // bundle, 20-25 ms more on Linux and Windows. Bytecode did the same at 3 MB more (#435).
  const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--format=esm", "--splitting",
    ...options.target === undefined ? [] : [`--target=${options.target}`], "--asset-naming=[name].[ext]",
    options.entry ?? engine, ...embedded(), "--outfile", outfile], { cwd: repository, stdout: "ignore", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`bun build --compile failed:\n${build.stderr.toString()}`);
}

if (import.meta.main) {
  const [folder] = process.argv.slice(2);
  if (folder === undefined) throw new Error("Usage: bun scripts/build.ts <folder>");
  mkdirSync(folder, { recursive: true });
  for (const target of targets) {
    build(join(folder, `tesota-${target.replace(/^bun-/u, "")}${target.includes("windows") ? ".exe" : ""}`), { target });
    console.log(`Built ${target}`);
  }
}
