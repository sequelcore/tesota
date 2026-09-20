import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { buildTypecheckContainerInvocation } from "../src/command-isolation.js";
import { executeRepositoryTypecheckContainer } from "../src/repository-typecheck-process.js";

const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn, spawnSync };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawn.mockReset();
  spawnSync.mockReset();
});

function child() {
  return Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn() });
}

function invocation() {
  return buildTypecheckContainerInvocation({ candidate: "C:\\candidate", nodeModules: "C:\\source\\node_modules" },
    "C:\\docker.exe", "tesota-typecheck-fixed");
}

it("requires observed client settlement after timeout even when container removal succeeds", async () => {
  vi.useFakeTimers();
  const process = child();
  spawn.mockReturnValue(process);
  spawnSync.mockReturnValue({ error: undefined, status: 0, stderr: "" });

  const running = executeRepositoryTypecheckContainer(invocation(), "tesota-typecheck-fixed");
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(2_000);

  await expect(running).resolves.toMatchObject({ status: "failed", reason: "timeout", process: "unconfirmed",
    container: "absent", pid: 4242 });
  expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  expect(process.unref).toHaveBeenCalledOnce();
});

it("does not spawn after cancellation has already been observed", async () => {
  const cancellation = new AbortController();
  cancellation.abort();

  await expect(executeRepositoryTypecheckContainer(invocation(), "tesota-typecheck-fixed", cancellation.signal))
    .resolves.toEqual({ status: "failed", reason: "cancelled", process: "not_started", container: "absent" });
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

it("reports an undispatched spawn failure as unavailable without cleanup authority", async () => {
  const process = Object.assign(new EventEmitter(), { pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => false), unref: vi.fn() });
  spawn.mockReturnValue(process);

  const running = executeRepositoryTypecheckContainer(invocation(), "tesota-typecheck-fixed");
  process.emit("error", new Error("missing executable"));

  await expect(running).resolves.toEqual({ status: "failed", reason: "spawn_failed", process: "not_started",
    container: "absent" });
  expect(spawnSync).not.toHaveBeenCalled();
});

it("cancels a started invocation and keeps client settlement distinct", async () => {
  vi.useFakeTimers();
  const process = child();
  spawn.mockReturnValue(process);
  spawnSync.mockReturnValue({ error: undefined, status: 0, stderr: "" });
  const cancellation = new AbortController();

  const running = executeRepositoryTypecheckContainer(invocation(), "tesota-typecheck-fixed", cancellation.signal);
  cancellation.abort();
  await vi.advanceTimersByTimeAsync(2_000);

  await expect(running).resolves.toMatchObject({ status: "failed", reason: "cancelled", process: "unconfirmed",
    container: "absent" });
});

it("reports unconfirmed cleanup instead of the underlying timeout", async () => {
  vi.useFakeTimers();
  const process = child();
  spawn.mockReturnValue(process);
  spawnSync.mockReturnValue({ error: undefined, status: 1, stderr: "container still exists" });

  const running = executeRepositoryTypecheckContainer(invocation(), "tesota-typecheck-fixed");
  await vi.advanceTimersByTimeAsync(60_000);

  await expect(running).resolves.toMatchObject({ status: "failed", reason: "cleanup_unconfirmed",
    process: "unconfirmed", container: "unconfirmed" });
});

it("publishes compiler output only after close and confirmed container absence", async () => {
  const process = child();
  spawn.mockReturnValue(process);
  spawnSync
    .mockReturnValueOnce({ error: undefined, status: 1, stderr: "already removed" })
    .mockReturnValueOnce({ error: undefined, status: 1, stderr: "No such container: tesota-typecheck-fixed" });
  const running = executeRepositoryTypecheckContainer(invocation(), "tesota-typecheck-fixed");
  process.stdout.write("diagnostic\n");
  process.emit("close", 1, null);

  await expect(running).resolves.toMatchObject({ status: "closed", exitCode: 1, signal: null,
    stdout: Buffer.from("diagnostic\n"), process: "exited", container: "absent" });
});
