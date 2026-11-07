import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { type Lane, lanes } from "../tests/lanes.ts";

/**
 * Runs the engine's tests: every file, or one lane's files when the first
 * argument names a lane (`tests/lanes.ts`). The files run as several shards
 * at once, each in a home and temporary folder of its own (`isolated.ts`),
 * since a process the engine starts gets the environment Bun began with and
 * so can't be given a home per file. The shards are balanced by how long
 * each file took (`tests/timings.json`, refreshed with `--update-timings`).
 * `--jobs=N` sets how many run at once: by default half the cores, at most
 * four. `--shard=k/K`, CI's split across runners, runs the k-th of K parts
 * the same way. Other arguments go to `bun test`.
 */
const argv = process.argv.slice(2);
const names = [...Object.keys(lanes), "processes"];
const lane = argv[0] !== undefined && names.includes(argv[0]) ? argv[0] as Lane : undefined;
const given = lane === undefined ? argv : argv.slice(1);
const value = (flag: string) => given.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
const jobs = Number(value("--jobs") ?? Math.min(4, Math.max(1, Math.ceil(availableParallelism() / 2))));
const [part, parts] = (value("--shard") ?? "1/1").split("/").map(Number) as [number, number];
const update = given.includes("--update-timings");
const options = given.filter((arg) => !arg.startsWith("--jobs=") && !arg.startsWith("--shard=") && arg !== "--update-timings");
if (!Number.isInteger(jobs) || jobs < 1 || !Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || part > parts) {
  throw new Error("Usage: bun scripts/tests.ts [lane] [--jobs=N] [--shard=k/K] [--update-timings] [bun test options]");
}

const root = join(import.meta.dir, "..");
const listed: readonly string[] = Object.values(lanes).flat();
const files = lane === undefined ? []
  : lane === "processes" ? readdirSync(join(root, "tests")).filter((name) => name.endsWith(".test.ts") && !listed.includes(name))
  : lanes[lane];
const preload = lane === "pure" ? ["--preload", join(import.meta.dir, "../../../tests/no-processes.ts")] : [];
const timings = join(root, "tests", "timings.json");
const scratch = mkdtempSync(join(tmpdir(), "tesota-core-timings-"));

interface Shard { readonly index: number; readonly written: string }
const total = parts * jobs;
const shards: Shard[] = Array.from({ length: jobs }, (_, job) => ({ index: (part - 1) * jobs + job + 1, written: join(scratch, `${job}.json`) }));

async function run(shard: Shard): Promise<number> {
  // With --update-timings, each shard writes its own files' times to the first --timings file; they're merged after.
  if (update) writeFileSync(shard.written, JSON.stringify({ version: 1, files: {} }));
  const times = [...update ? [`--timings=${shard.written}`] : [], ...existsSync(timings) ? [`--timings=${timings}`] : []];
  const child = Bun.spawn(["bun", join(import.meta.dir, "isolated.ts"), "bun", "test", "--timeout", "30000", ...preload,
    `--shard=${shard.index}/${total}`, ...times, ...update ? ["--update-timings"] : [], ...options,
    ...files.map((name) => `./tests/${name}`)], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  process.stdout.write(`\n=== Shard ${shard.index} of ${total}, exit ${code}\n${out}${err}`);
  return code;
}

try {
  const codes = await Promise.all(shards.map(run));
  if (update && codes.every((code) => code === 0)) {
    const read = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { files: Record<string, number> }).files;
    const merged = { ...existsSync(timings) ? read(timings) : {}, ...Object.assign({}, ...shards.map((shard) => read(shard.written))) };
    const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(timings, `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(sorted).length} files' times to tests/timings.json.`);
  }
  process.exitCode = codes.find((code) => code !== 0) ?? 0;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
