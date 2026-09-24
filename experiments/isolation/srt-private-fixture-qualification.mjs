// Follow-up: exercise SRT under a task-owned, inheritance-protected Windows ACL.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") throw new Error("Windows only");
const packageRoot = process.argv[2];
if (!packageRoot || !isAbsolute(packageRoot)) throw new Error("Pass the absolute SRT package root");
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
if (version !== "0.0.77") throw new Error("This probe is pinned to SRT 0.0.77");
const { SandboxManager, VENDORED_SRT_WIN_EXE, checkWindowsSandboxStatusAsync, resolveSrtWin } =
  await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
const setup = await checkWindowsSandboxStatusAsync({ srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) });
if (!setup.user.provisioned || !setup.user.credPresent) {
  console.log(JSON.stringify({ status: "unavailable", reason: "Windows sandbox setup is absent" }));
  process.exit(2);
}

const parent = resolve(packageRoot, "../../..");
const root = mkdtempSync(join(parent, "tesota-srt-private-"));
const sharedRoot = mkdtempSync(join(parent, "tesota-srt-shared-"));
const difference = relative(parent, root);
const sharedDifference = relative(parent, sharedRoot);
if ([difference, sharedDifference].some((part) => !part || part === ".." ||
  part.startsWith(`..${sep}`) || isAbsolute(part))) {
  throw new Error("Unexpected fixture path");
}
const candidate = join(root, "candidate");
const source = join(candidate, "src");
const compiler = join(root, "compiler");
const nativeCompiler = join(root, "node_modules", "@typescript", "typescript-win32-x64");
const outside = join(root, "outside");
const user = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
const icacls = (...args) => execFileSync("icacls.exe", args, { encoding: "utf8", windowsHide: true });
const acl = (path) => icacls(path);
const run = async (command) => {
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, undefined, candidate);
  return await new Promise((resolveResult, reject) => {
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: candidate, env: wrapped.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(0, 8192); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, 8192); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, timedOut, stdout, stderr });
    });
  });
};

let initialized = false;
let report;
try {
  // Protect only this new fixture. Its descendants are created afterward and
  // inherit the caller's explicit grant, with no broad Users write grant.
  icacls(root, "/grant:r", `${user}:(OI)(CI)F`);
  icacls(root, "/inheritance:r");
  const rootAcl = acl(root);
  const privateRoot = !/Authenticated Users|BUILTIN\\Usuarios|BUILTIN\\Users/iu.test(rootAcl);
  for (const directory of [source, outside]) mkdirSync(directory, { recursive: true });
  cpSync(resolve("node_modules/typescript"), compiler, { recursive: true });
  mkdirSync(join(root, "node_modules", "@typescript"), { recursive: true });
  cpSync(resolve("node_modules/@typescript/typescript-win32-x64"), nativeCompiler, { recursive: true });
  const tsc = join(compiler, "bin", "tsc");
  writeFileSync(join(candidate, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: "ES2022", types: [], skipLibCheck: true,
  }, include: ["src/**/*.ts"] }));
  const math = join(source, "math.ts");
  writeFileSync(math, "export function double(value: number): number { return value * 2; }\n");
  writeFileSync(join(outside, "sentinel.txt"), "private\n");
  writeFileSync(join(sharedRoot, "sentinel.txt"), "shared\n");
  symlinkSync(outside, join(candidate, "outside-link"), "junction");
  symlinkSync(sharedRoot, join(candidate, "shared-link"), "junction");
  writeFileSync(join(candidate, "access-probe.mjs"), `import { readFileSync, writeFileSync } from 'node:fs';
const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
const outside = ${JSON.stringify(outside)};
const candidate = ${JSON.stringify(candidate)};
const compiler = ${JSON.stringify(compiler)};
const nativeCompiler = ${JSON.stringify(nativeCompiler)};
const shared = ${JSON.stringify(sharedRoot)};
console.log(JSON.stringify({
  username: process.env.USERNAME,
  directOutsideRead: attempt(() => readFileSync(outside + '/sentinel.txt')),
  aliasOutsideRead: attempt(() => readFileSync(candidate + '/outside-link/sentinel.txt')),
  directOutsideWrite: attempt(() => writeFileSync(outside + '/direct-new.txt', 'escape')),
  aliasOutsideWrite: attempt(() => writeFileSync(candidate + '/outside-link/alias-new.txt', 'escape')),
  directSharedRead: attempt(() => readFileSync(shared + '/sentinel.txt')),
  aliasSharedRead: attempt(() => readFileSync(candidate + '/shared-link/sentinel.txt')),
  directSharedWrite: attempt(() => writeFileSync(shared + '/direct-new.txt', 'escape')),
  aliasSharedWrite: attempt(() => writeFileSync(candidate + '/shared-link/alias-new.txt', 'escape')),
  compilerWrite: attempt(() => writeFileSync(compiler + '/escape.txt', 'escape')),
  nativeCompilerWrite: attempt(() => writeFileSync(nativeCompiler + '/escape.txt', 'escape')),
  admittedSourceWrite: attempt(() => writeFileSync(candidate + '/src/math.ts', 'export const result = 2;')),
}));`);
  const aclPaths = [root, candidate, math, compiler, nativeCompiler, outside];
  const before = aclPaths.map(acl);
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [], allowRead: [candidate, compiler, join(root, "node_modules")],
      allowWrite: [math], denyWrite: [] },
    windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
  });
  initialized = true;
  const good = await run(`node "${tsc}" --noEmit -p tsconfig.json`);
  writeFileSync(math, "export const count: number = 'wrong';\n");
  const bad = await run(`node "${tsc}" --noEmit -p tsconfig.json`);
  const access = await run("node access-probe.mjs");
  let accessResult;
  try { accessResult = JSON.parse(access.stdout.split(/\r?\n/u)[0]); } catch { /* Report fails below. */ }
  await SandboxManager.reset();
  initialized = false;
  const restored = aclPaths.map(acl).every((value, index) => value === before[index]);
  report = {
    status: "failed",
    privateRoot,
    validTypecheck: good.code === 0 && !good.timedOut,
    invalidTypecheckRejected: bad.code !== 0 && /TS2322/u.test(bad.stdout + bad.stderr) && !bad.timedOut,
    accessProbeRan: access.code === 0 && !access.timedOut && accessResult !== undefined,
    access: accessResult,
    aclRestored: restored,
    diagnostics: {
      valid: good.code === 0 ? undefined : (good.stderr || good.stdout).slice(0, 1000),
      invalid: /TS2322/u.test(bad.stdout + bad.stderr) ? undefined : (bad.stderr || bad.stdout).slice(0, 1000),
      access: accessResult ? undefined : (access.stderr || access.stdout).slice(0, 1000),
    },
  };
  const a = accessResult;
  const privateFixturePassed = privateRoot && report.validTypecheck && report.invalidTypecheckRejected
    && report.accessProbeRan
    && a?.username === "srt-sandbox" && a.directOutsideRead === false && a.aliasOutsideRead === false
    && a.directOutsideWrite === false && a.aliasOutsideWrite === false && a.compilerWrite === false
    && a.nativeCompilerWrite === false
    && a.admittedSourceWrite === true && restored;
  const hostScopePassed = privateFixturePassed && a.directSharedRead === false && a.aliasSharedRead === false
    && a.directSharedWrite === false && a.aliasSharedWrite === false;
  report.privateFixturePassed = privateFixturePassed;
  report.hostScopePassed = hostScopePassed;
  report.status = hostScopePassed ? "passed" : "failed";
  console.log(JSON.stringify(report));
  process.exitCode = hostScopePassed ? 0 : 1;
} finally {
  if (initialized) await SandboxManager.reset();
  rmSync(root, { recursive: true, force: true });
  rmSync(sharedRoot, { recursive: true, force: true });
}
