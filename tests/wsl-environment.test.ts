import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { HostMessage } from "../src/bubblewrap-sandbox.js";
import { TOOLCHAIN_HOSTS } from "../src/toolchain.js";
import { bubblewrapEnvironment, type Launch } from "../src/wsl-environment.js";

/**
 * The host's side of the WSL sandbox (decision 043) against stand-in sandbox
 * processes that speak its messages without bubblewrap: what a failed start
 * reports, what setting a repository up asks for (decision 048), how a
 * command's output and end come back, and what the host concludes when the
 * process is gone. The live suite, `TESOTA_LIVE_WSL=1`,
 * runs the real one.
 */
let workspace = "";
beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), "tesota-wsl-host-")); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

/** A stand-in that answers `ready`, then runs each `run` message's command as its output, echoing its cwd. */
const standIn = (behavior: string): Launch => () => spawn(process.execPath, ["-e", `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "ready", workspace: "/mnt/c/workspace", toolchains: "/home/tesota/.local/state/tesota/toolchains/k" });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  ${behavior}
});`]);

it("reports why the sandbox's process could not start", async () => {
  const failing: Launch = () => spawn(process.execPath, ["-e",
    "process.stdout.write(JSON.stringify({ type: 'failed', message: 'bubblewrap (bwrap) is not installed' }) + '\\n')"]);
  await expect(bubblewrapEnvironment(failing, workspace)).rejects.toThrow("The WSL sandbox could not start: bubblewrap (bwrap) is not installed");
  const silent: Launch = () => spawn(process.execPath, ["-e", "process.stderr.write('node: not found'); process.exit(127)"]);
  await expect(bubblewrapEnvironment(silent, workspace)).rejects.toThrow("node: not found");
});

it("runs a command from its folder relative to the workspace, streams its output and returns how it ended", async () => {
  const environment = await bubblewrapEnvironment(standIn(`
  if (message.type === "run") {
    send({ type: "output", id: message.id, data: Buffer.from(message.cwd + ":" + message.command + ":" + message.env.GIVEN).toString("base64") });
    send({ type: "ended", id: message.id, outcome: "exited", exitCode: 3, refused: [] });
  }`), workspace);
  try {
    expect(environment.commandRoot).toBe("/mnt/c/workspace");
    let output = "";
    const result = await environment.run("make", { cwd: join(workspace, "src", "lib"), env: { GIVEN: "yes" },
      onOutput: (chunk) => { output += chunk.toString(); } });
    expect(result).toEqual({ outcome: "exited", exitCode: 3, refused: [] });
    expect(output).toBe("src/lib:make:yes");
    expect(await environment.run("make", { cwd: join(workspace, ".."), onOutput: () => undefined }))
      .toEqual({ outcome: "not_started", exitCode: null });
  } finally { await environment.dispose(); }
});

it("asks the sandbox to stop a cancelled command, and cannot confirm a command whose process is gone", async () => {
  const environment = await bubblewrapEnvironment(standIn(`
  if (message.type === "stop") send({ type: "ended", id: message.id, outcome: "cancelled", exitCode: null, refused: [] });
  if (message.type === "run" && message.command === "crash") process.exit(1);`), workspace);
  try {
    const cancellation = new AbortController();
    const running = environment.run("sleep", { cwd: workspace, signal: cancellation.signal, onOutput: () => undefined });
    cancellation.abort();
    expect(await running).toEqual({ outcome: "cancelled", exitCode: null, refused: [] });
    expect(await environment.run("crash", { cwd: workspace, onOutput: () => undefined })).toEqual({ outcome: "unconfirmed", exitCode: null, refused: [] });
    expect(await environment.run("after", { cwd: workspace, onOutput: () => undefined })).toEqual({ outcome: "unconfirmed", exitCode: null, refused: [] });
  } finally { await environment.dispose(); }
});

/** A repository of these files in a folder of its own. */
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(workspace, "repository-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** A stand-in that announces each setup stage, then answers with the setup message itself as the one step's output. */
const settingUp = (answer = ""): Launch => standIn(`
  if (message.type === "setup") {
    for (const stage of message.stages) send({ type: "stage", id: message.id, description: stage.description });
    send({ type: "prepared", id: message.id, steps: [{ description: "setup", outcome: "done", output: JSON.stringify(message) }]${answer} });
  }`);

it("sets the repository up in one message: pinned runtimes Tesota does not carry, its setup script, and the download hosts", async () => {
  const repo = await repository({ ".nvmrc": "20\n", ".tesota/setup.sh": "npm ci\n", "package-lock.json": "{}" });
  const progress: string[] = [];
  const environment = await bubblewrapEnvironment(settingUp(), repo, { onProgress: (text) => { progress.push(text); } });
  try {
    const sent = JSON.parse(environment.preparation[0]?.output ?? "{}") as Extract<HostMessage, { type: "setup" }>;
    expect(sent.stages).toEqual([
      { description: "Install node 20", script: "set -eu\nmise use --global node@20" },
      { description: "Find the installed tools", script: "mise bin-paths", toolFolders: true },
      { description: "Run .tesota/setup.sh", script: "sh .tesota/setup.sh" }]);
    expect(sent.destinations).toEqual(TOOLCHAIN_HOSTS.map((host) => `${host}:443`));
    // mise installs into the repository's toolchain folder, and trusts only the workspace's own files.
    expect(sent.env).toEqual({ MISE_DATA_DIR: "/home/tesota/.local/state/tesota/toolchains/k", MISE_YES: "1",
      MISE_HIDE_UPDATE_WARNING: "1", MISE_TRUSTED_CONFIG_PATHS: "/mnt/c/workspace" });
    expect(sent.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(progress).toEqual(["Preparing the sandbox: Install node 20", "Preparing the sandbox: Find the installed tools",
      "Preparing the sandbox: Run .tesota/setup.sh"]);
  } finally { await environment.dispose(); }
});

it("opens no download hosts for a lockfile install alone, and sends nothing when the repository needs no setup", async () => {
  // Tesota's own Node satisfies a pin on its major version, so nothing is downloaded for it.
  const lockfile = await bubblewrapEnvironment(settingUp(), await repository({ "package-lock.json": "{}", ".nvmrc": "24\n" }));
  try {
    const sent = JSON.parse(lockfile.preparation[0]?.output ?? "{}") as Extract<HostMessage, { type: "setup" }>;
    expect(sent.stages).toEqual([{ description: "Install dependencies (npm ci)", script: "npm ci" }]);
    expect(sent.destinations).toEqual([]);
  } finally { await lockfile.dispose(); }
  const bare = await bubblewrapEnvironment(settingUp(), await repository({ "README.md": "hi" }));
  try { expect(bare.preparation).toEqual([]); } finally { await bare.dispose(); }
});

it("stops preparing when the sandbox could not confirm setup's hosts closed", async () => {
  const repo = await repository({ ".tesota/setup.sh": "true\n" });
  await expect(bubblewrapEnvironment(settingUp(", error: \"Setup's destinations could not be confirmed closed: github.com:443\""), repo))
    .rejects.toThrow("The WSL sandbox stopped: Setup's destinations could not be confirmed closed: github.com:443");
});

it("returns what the sandbox's proxy refused during each command, and passes on what the operator allows", async () => {
  const environment = await bubblewrapEnvironment(standIn(`
  if (message.type === "allow") globalThis.allowed = message.destinations;
  if (message.type === "run") send({ type: "ended", id: message.id, outcome: "exited", exitCode: 7,
    refused: globalThis.allowed === undefined ? ["example.com:443"] : [] });`), workspace);
  try {
    expect(await environment.run("curl", { cwd: workspace, onOutput: () => undefined }))
      .toEqual({ outcome: "exited", exitCode: 7, refused: ["example.com:443"] });
    await environment.network?.allow(["example.com:443"]);
    expect((await environment.run("curl", { cwd: workspace, onOutput: () => undefined })).refused).toEqual([]);
    await expect(environment.network?.allow(["not a destination"])).rejects.toThrow("Only host:port destinations can be allowed");
  } finally { await environment.dispose(); }
});
