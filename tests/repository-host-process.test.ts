import { expect, it } from "vitest";
import { executeRepositoryHostProcess } from "../src/repository-host-process.js";

const limits = { timeoutMs: 1_000, terminationWaitMs: 1_000, maxOutputBytes: 4_096 };

it.runIf(process.platform === "win32")("settles a bounded host process without a container", async () => {
  const observation = await executeRepositoryHostProcess(process.execPath, ["-e", "process.stdout.write('ok')"],
    process.cwd(), limits);
  expect(observation).toMatchObject({ status: "closed", process: "exited", container: "absent",
    exitCode: 0, stdout: Buffer.from("ok") });
});

it.runIf(process.platform === "win32")("does not claim cancellation proves child-process settlement", async () => {
  const controller = new AbortController();
  const running = executeRepositoryHostProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(), limits, controller.signal);
  controller.abort();
  await expect(running).resolves.toMatchObject({ status: "failed", reason: "cancelled",
    process: "unconfirmed", container: "absent" });
});

it.runIf(process.platform === "win32")("keeps timed-out host work unconfirmed", async () => {
  const observation = await executeRepositoryHostProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(), { ...limits, timeoutMs: 100 });
  expect(observation).toMatchObject({ status: "failed", reason: "timeout", process: "unconfirmed",
    container: "absent" });
});
