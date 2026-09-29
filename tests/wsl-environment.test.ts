import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bubblewrapEnvironment, type Launch } from "../src/wsl-environment.js";

/**
 * The host's side of the WSL sandbox (decision 043) against stand-in sandbox
 * processes that speak its messages without bubblewrap: what a failed start
 * reports, how a command's output and end come back, and what the host
 * concludes when the process is gone. The live suite, `TESOTA_LIVE_WSL=1`,
 * runs the real one.
 */
let workspace = "";
beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), "tesota-wsl-host-")); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

/** A stand-in that answers `ready`, then runs each `run` message's command as its output, echoing its cwd. */
const standIn = (behavior: string): Launch => () => spawn(process.execPath, ["-e", `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "ready", workspace: "/mnt/c/workspace" });
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
