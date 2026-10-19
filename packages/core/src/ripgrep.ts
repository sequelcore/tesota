import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import pin from "../../../ripgrep.json" with { type: "json" };
import { inBinary } from "../../../src/binary.ts";
import { tesotaHome } from "../../../src/home.ts";
import { runProcess } from "../../../src/process.ts";
import { judge } from "./permissions.ts";

export const hostTarget: string = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const triples: Readonly<Record<string, string>> = pin.targets;
const assets: Readonly<Record<string, { readonly executableSha256: string }>> = pin.assets;
const asset = assets[triples[hostTarget] ?? ""];
const name = process.platform === "win32" ? "rg.exe" : "rg";
let extracted: Promise<string> | undefined;

/** The pinned executable, from the checkout or extracted atomically from this binary. */
export async function ripgrepPath(source: string = fileURLToPath(new URL(`../../../vendor/ripgrep/${hostTarget}/${name}`, import.meta.url))): Promise<string> {
  if (!inBinary) {
    try { await access(source, constants.X_OK); }
    catch { throw new Error(`Bundled ripgrep is missing or not executable at ${source}; run \`bun run vendor\` in the checkout.`); }
    return source;
  }
  extracted ??= (async () => {
    if (asset === undefined) throw new Error(`Unsupported ripgrep target: ${hostTarget}`);
    const hash = asset.executableSha256;
    const directory = join(tesotaHome(), "ripgrep", `${pin.version}-${hash}`);
    const destination = join(directory, name);
    const existing = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing === undefined || createHash("sha256").update(existing).digest("hex") !== hash) {
      const embedded = await readFile(fileURLToPath(new URL(`./${name}`, import.meta.url)));
      await mkdir(directory, { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, embedded, { flag: "wx", mode: 0o755 });
        if (createHash("sha256").update(await readFile(temporary)).digest("hex") !== hash) throw new Error("Embedded ripgrep SHA-256 mismatch");
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
    }
    if (process.platform !== "win32") await chmod(destination, 0o755);
    return destination;
  })();
  return extracted;
}

/** Ignore rules apply in plain folders too; hidden files are included, Git's private files are not. */
const ripgrepArguments: readonly string[] = ["--no-config", "--hidden", "--no-require-git", "--glob=!.git", "--color=never"];

/** Runs bounded ripgrep records through the process owner; a full consumer stops it and awaits its exit. */
export async function runRipgrep(cwd: string, args: readonly string[], signal: AbortSignal,
  onRecord: (record: string) => boolean, timeoutMs = 10_000, separator = "\n"): Promise<void> {
  signal.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const executable = await ripgrepPath();
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("ripgrep deadline exceeded");
  const full = new AbortController();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let stopped = false;
  const result = await runProcess(executable, [...ripgrepArguments, ...args], cwd, AbortSignal.any([signal, full.signal]), remaining,
    undefined, { onStdout: (chunk) => {
      if (stopped) return;
      const records = (pending + decoder.write(chunk)).split(separator);
      pending = records.pop() ?? "";
      for (const record of records) {
        if (!onRecord(record)) { stopped = true; full.abort(); break; }
      }
    } });
  signal.throwIfAborted();
  if (stopped) return;
  if (result.ended === "timed_out") throw new Error("ripgrep deadline exceeded");
  if (result.ended !== "exited" || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new Error(result.stderr || result.output || `ripgrep failed (${result.ended}, ${result.exitCode})`);
  }
}

/** Files relative to `cwd`, sorted and capped, with an exact count of files left out. */
export async function listFiles(cwd: string, options: {
  readonly glob?: string; readonly limit?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal;
} = {}): Promise<{ files: string[]; omitted: number }> {
  options.signal?.throwIfAborted();
  const limit = Math.max(0, Math.floor(options.limit ?? 20_000));
  const deadline = performance.now() + (options.timeoutMs ?? 10_000);
  const root = await realpath(cwd);
  if ((process.platform === "win32" ? root.toLowerCase() : root).split(/[\\/]/u).includes(".git")) return { files: [], omitted: 0 };
  const files: string[] = [];
  // A positive rg glob overrides ignore rules. Intersect its result with rg's ordinary ignored-file listing.
  const matching = options.glob === undefined ? undefined : new Set<string>();
  if (matching !== undefined && options.glob !== undefined) {
    await runRipgrep(cwd, ["--files", "--null", "--path-separator=/", "--glob", options.glob],
      options.signal ?? new AbortController().signal, (file) => {
        matching.add(file);
        return true;
      }, deadline - performance.now(), "\0");
  }
  let count = 0;
  await runRipgrep(cwd, ["--files", "--null", "--path-separator=/"],
    options.signal ?? new AbortController().signal, (file) => {
      if (matching !== undefined && !matching.has(file)) return true;
      if (judge({ type: "toolCall", id: "", name: "read", arguments: { path: file } }, "read", cwd, "read", [], false).decision === "deny") return true;
      count++;
      files.push(file);
      // Retain only the earliest names; counting the remaining records still gives an exact omitted count.
      if (files.length > Math.max(1, limit * 2)) { files.sort(); files.splice(limit); }
      return true;
    }, deadline - performance.now(), "\0");
  files.sort();
  return { files: files.slice(0, limit), omitted: Math.max(0, count - limit) };
}
