// Fixed Windows follow-up for sandbox-runtime 0.0.77. No task authority.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") throw new Error("This qualification requires Windows");
const packageRoot = process.argv[2];
if (!packageRoot || !isAbsolute(packageRoot)) throw new Error("Pass the absolute sandbox-runtime package root");
const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
if (packageVersion !== "0.0.77") throw new Error("This qualification is pinned to sandbox-runtime 0.0.77");
const { SandboxManager, VENDORED_SRT_WIN_EXE, checkWindowsSandboxStatusAsync, resolveSrtWin } =
  await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
const setup = await checkWindowsSandboxStatusAsync({ srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) });
if (!setup.user.provisioned || !setup.user.credPresent) {
  console.log(JSON.stringify({ status: "unavailable", reason: "Windows sandbox setup is absent" }));
  process.exit(2);
}

const root = mkdtempSync(join(resolve(packageRoot, "../../.."), "tesota-srt-repo-"));
const candidate = join(root, "candidate");
const source = join(candidate, "src");
const outside = join(root, "outside");
const alias = join(candidate, "outside-link");
const compiler = resolve("node_modules/typescript");
const tsc = join(compiler, "bin", "tsc");
for (const directory of [source, outside]) mkdirSync(directory, { recursive: true });
writeFileSync(join(candidate, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  strict: true, noEmit: true, target: "ES2022", types: [], skipLibCheck: true,
}, include: ["src/**/*.ts"] }));
writeFileSync(join(source, "math.ts"), "export function double(value: number): number { return value * 2; }\n");
writeFileSync(join(outside, "protected.txt"), "protected\n");
writeFileSync(join(outside, "open.txt"), "outside\n");
symlinkSync(outside, alias, "junction");

const probe = `import { readFileSync, writeFileSync } from 'node:fs';
const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
const outside = ${JSON.stringify(outside)};
const alias = ${JSON.stringify(alias)};
console.log(JSON.stringify({
  user: process.env.USERNAME,
  directProtectedRead: attempt(() => readFileSync(outside + '/protected.txt')),
  aliasProtectedRead: attempt(() => readFileSync(alias + '/protected.txt')),
  directOpenRead: attempt(() => readFileSync(outside + '/open.txt')),
  aliasOpenRead: attempt(() => readFileSync(alias + '/open.txt')),
  directOutsideWrite: attempt(() => writeFileSync(outside + '/new-direct.txt', 'escape')),
  aliasOutsideWrite: attempt(() => writeFileSync(alias + '/new-alias.txt', 'escape')),
}));`;
writeFileSync(join(candidate, "alias-probe.mjs"), probe);
writeFileSync(join(candidate, "resource-probe.mjs"),
  "const data = Buffer.alloc(160 * 1024 * 1024, 1); console.log(JSON.stringify({ bytes: data.length, rss: process.memoryUsage().rss }));\n");
const acl = (path) => execFileSync("icacls.exe", [path], { encoding: "utf8", windowsHide: true });
const aclPaths = [candidate, outside, join(outside, "protected.txt"), compiler];
const aclBefore = aclPaths.map(acl);
const execute = async (command) => {
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, undefined, candidate);
  return await new Promise((resolveResult, reject) => {
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: candidate, env: wrapped.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(0, 8192); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, 8192); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
};

let initialized = false;
let observation;
let resetError;
try {
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: [join(outside, "protected.txt")],
      allowRead: [candidate, compiler],
      allowWrite: [],
      denyWrite: [],
    },
    windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
  });
  initialized = true;
  const aclDuring = aclPaths.map(acl).map((value, index) => value !== aclBefore[index]);
  const command = `node "${tsc}" --noEmit -p tsconfig.json`;
  const valid = await execute(command);
  writeFileSync(join(source, "math.ts"), "export const count: number = 'wrong';\n");
  const invalid = await execute(command);
  const aliases = await execute("node alias-probe.mjs");
  const resource = await execute("node resource-probe.mjs");
  let aliasReport;
  try { aliasReport = JSON.parse(aliases.stdout.split(/\r?\n/u)[0]); } catch { /* Missing report is visible. */ }
  let resourceReport;
  try { resourceReport = JSON.parse(resource.stdout.split(/\r?\n/u)[0]); } catch { /* Missing report is visible. */ }
  observation = {
    validTypecheck: valid.code === 0,
    invalidTypecheckRejected: invalid.code !== 0 && /TS2322/u.test(invalid.stdout + invalid.stderr),
    aliasProbeRan: aliases.code === 0 && aliasReport !== undefined,
    aliasReport,
    over128MiBAllocationSucceeded: resource.code === 0 && resourceReport?.bytes === 160 * 1024 * 1024,
    aclChangedDuringRun: aclDuring,
    diagnostics: {
      valid: valid.code === 0 ? undefined : (valid.stderr || valid.stdout).slice(0, 1000),
      invalid: invalid.code === 0 ? "Invalid TypeScript unexpectedly passed" : undefined,
      alias: aliasReport ? undefined : (aliases.stderr || aliases.stdout).slice(0, 1000),
      resource: resourceReport ? undefined : (resource.stderr || resource.stdout).slice(0, 1000),
    },
  };
} finally {
  if (initialized) {
    try { await SandboxManager.reset(); } catch (error) { resetError = error; }
  }
}
const aclRestored = aclPaths.map(acl).every((value, index) => value === aclBefore[index]);
let combinedDeny;
let combinedResetError;
try {
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: [join(outside, "protected.txt")],
      allowRead: [candidate, compiler],
      allowWrite: [],
      denyWrite: [join(outside, "protected.txt")],
    },
    windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
  });
  const result = await execute("node alias-probe.mjs");
  try { combinedDeny = JSON.parse(result.stdout.split(/\r?\n/u)[0]); } catch { /* Missing report fails below. */ }
} finally {
  try { await SandboxManager.reset(); } catch (error) { combinedResetError = error; }
}
const combinedAclRestored = aclPaths.map(acl).every((value, index) => value === aclBefore[index]);
const report = {
  provider: "sandbox-runtime", packageVersion,
  ...observation,
  aclRestored,
  resetSucceeded: resetError === undefined,
  combinedDeny: {
    directProtectedRead: combinedDeny?.directProtectedRead,
    aliasProtectedRead: combinedDeny?.aliasProtectedRead,
    aclRestored: combinedAclRestored,
    resetSucceeded: combinedResetError === undefined,
  },
};
const passed = report.validTypecheck && report.invalidTypecheckRejected && report.aliasProbeRan
  && report.aliasReport?.directProtectedRead === false && report.aliasReport.aliasProtectedRead === false
  && report.aliasReport.directOpenRead === false && report.aliasReport.aliasOpenRead === false
  && report.aliasReport.directOutsideWrite === false && report.aliasReport.aliasOutsideWrite === false
  && combinedDeny?.directProtectedRead === false && combinedDeny.aliasProtectedRead === false
  && aclRestored && combinedAclRestored && report.resetSucceeded && combinedResetError === undefined;
console.log(JSON.stringify({ status: passed ? "passed" : "failed", ...report }));
process.exitCode = passed ? 0 : 1;
rmSync(root, { recursive: true, force: true });
