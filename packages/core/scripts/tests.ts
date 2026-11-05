import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Lane, lanes } from "../tests/lanes.ts";

/**
 * Runs the engine's tests: every file, or one lane's files when the first
 * argument names a lane (`tests/lanes.ts`). Other arguments go to `bun test`.
 */
const [first, ...rest] = process.argv.slice(2);
const names = [...Object.keys(lanes), "processes"];
const lane = first !== undefined && names.includes(first) ? first as Lane : undefined;
const options = lane === undefined ? process.argv.slice(2) : rest;
const listed: readonly string[] = Object.values(lanes).flat();
const files = lane === undefined ? []
  : lane === "processes" ? readdirSync(join(import.meta.dir, "../tests")).filter((name) => name.endsWith(".test.ts") && !listed.includes(name))
  : lanes[lane];
const preload = lane === "pure" ? ["--preload", join(import.meta.dir, "../../../tests/no-processes.ts")] : [];
const run = Bun.spawnSync(["bun", "test", "--timeout", "30000", ...preload, ...options, ...files.map((name) => `./tests/${name}`)],
  { cwd: join(import.meta.dir, ".."), stdio: ["inherit", "inherit", "inherit"] });
process.exit(run.exitCode ?? 1);
