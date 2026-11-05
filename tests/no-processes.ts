import module from "node:module";

/**
 * A test in the `pure` lane fails when it starts a process through
 * `node:child_process`, so the lane stays fast and safe to run in parallel.
 */
const childProcess = module.createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = () => {
    throw new Error(`A test in the pure lane started a process with ${name}; list its file in another lane (tests/lanes.ts).`);
  };
}
module.syncBuiltinESMExports();
