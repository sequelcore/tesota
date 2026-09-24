// Experimental, fixed Windows probe. Run with the absolute root of a pinned
// @anthropic-ai/sandbox-runtime installation as the only argument.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") throw new Error("This probe requires Windows");
const packageRoot = process.argv[2];
if (!packageRoot || !isAbsolute(packageRoot)) throw new Error("Pass the absolute sandbox-runtime package root");
const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
if (packageVersion !== "0.0.77") throw new Error("This probe is qualified only for sandbox-runtime 0.0.77");
const { SandboxManager, VENDORED_SRT_WIN_EXE, checkWindowsSandboxStatusAsync, resolveSrtWin } =
  await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
const status = await checkWindowsSandboxStatusAsync({ srtWin });
if (!status.user.provisioned || !status.user.credPresent) {
  console.log(JSON.stringify({ status: "unavailable", reason: "Windows sandbox setup is absent" }));
  process.exit(2);
}

// A Windows sandbox account cannot traverse the calling user's private temp
// profile. The package installation for this experiment lives under Sequel/cloned.
const root = mkdtempSync(join(resolve(packageRoot, "../../.."), "tesota-srt-"));
const candidate = join(root, "candidate");
const source = join(candidate, "source");
const build = join(root, "build");
const scratch = join(root, "scratch");
const outside = join(root, "outside");
for (const directory of [source, build, scratch, outside]) mkdirSync(directory, { recursive: true });
const paths = {
  TESOTA_SOURCE: join(source, "allowed.txt"),
  TESOTA_SIBLING: join(source, "denied.txt"),
  TESOTA_BUILD: join(build, "output.txt"),
  TESOTA_SCRATCH: join(scratch, "output.txt"),
  TESOTA_LATE: join(build, "late.txt"),
  TESOTA_CHILD_READY: join(scratch, "child-ready.txt"),
  TESOTA_OUTSIDE: join(outside, "sentinel.txt"),
};
for (const [name, value] of [["TESOTA_SOURCE", "original\n"], ["TESOTA_SIBLING", "unchanged\n"],
  ["TESOTA_OUTSIDE", "synthetic-private\n"]]) writeFileSync(paths[name], value);

const listen = () => new Promise((resolve, reject) => {
  const server = createServer((socket) => socket.end());
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const reachable = (port) => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
  socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let initialized = false;
let child;
try {
  server = await listen();
  const address = server.address();
  if (!address || typeof address === "string" || !await reachable(address.port)) {
    throw new Error("Positive network control unavailable");
  }
  // Reuse the fixed probe body. Only its path and network inputs are replaced;
  // the canary environment check remains untouched.
  const { ISOLATION_PROBE_SOURCE } = await import(pathToFileURL(join(process.cwd(), "dist", "command-isolation.js")).href);
  let probe = ISOLATION_PROBE_SOURCE;
  for (const [key, value] of Object.entries({ ...paths, TESOTA_NETWORK_HOST: "127.0.0.1",
    TESOTA_NETWORK_PORT: String(address.port) })) {
    probe = probe.replaceAll(`process.env.${key}`, JSON.stringify(value));
  }
  const childCode = `await import('node:fs/promises').then(m=>m.writeFile(${JSON.stringify(paths.TESOTA_CHILD_READY)},'ready\\n'));setTimeout(async()=>{await import('node:fs/promises').then(m=>m.writeFile(${JSON.stringify(paths.TESOTA_LATE)},'late\\n'))},2500)`;
  probe = probe.replace(/^const childCode = .*;$/mu, `const childCode = ${JSON.stringify(childCode)};`);
  writeFileSync(join(candidate, "isolation-probe.mjs"), probe);
  process.env.TESOTA_QUALIFICATION_SECRET = "synthetic-private";
  const config = {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: [paths.TESOTA_OUTSIDE],
      allowRead: [candidate],
      allowWrite: [paths.TESOTA_SOURCE, build, scratch],
      denyWrite: [paths.TESOTA_SIBLING],
    },
    windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
  };
  await SandboxManager.initialize(config);
  initialized = true;
  const wrapped = await SandboxManager.wrapWithSandboxArgv("node isolation-probe.mjs", undefined,
    undefined, undefined, candidate, { commandId: randomUUID() });
  let stdout = "";
  let stderr = "";
  let canceled = false;
  child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: candidate, env: wrapped.env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 16_384) stdout += chunk;
    if (stdout.includes("TESOTA_PROBE_READY") && !canceled) canceled = child.kill("SIGINT");
  });
  child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk; });
  let deadline;
  const settled = await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    new Promise((resolve) => { deadline = setTimeout(() => resolve(false), 15_000); }),
  ]);
  clearTimeout(deadline);
  if (!settled) child.kill("SIGKILL");
  await wait(3_000);
  const first = stdout.split(/\r?\n/u)[0];
  let report;
  try { report = JSON.parse(first); } catch { /* Missing or malformed report fails below. */ }
  const expected = ["sourceWrite", "siblingWriteDenied", "buildWrite", "scratchWrite",
    "outsideReadDenied", "credentialAbsent", "networkDenied", "descendantStarted"];
  const failed = expected.filter((key) => report?.[key] !== true);
  if (!canceled) failed.push("canceled");
  if (!settled || existsSync(paths.TESOTA_LATE)) failed.push("descendantSettled");
  console.log(JSON.stringify({ status: failed.length ? "failed" : "passed", failedControls: failed,
    provider: "sandbox-runtime", packageVersion, helper: "vendored", settled,
    diagnostic: report ? undefined : stderr.slice(0, 1600) }));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (initialized) await SandboxManager.reset();
  if (server) await close(server);
  rmSync(root, { recursive: true, force: true });
  delete process.env.TESOTA_QUALIFICATION_SECRET;
}
