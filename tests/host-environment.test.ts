import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";

const roots: string[] = [];
// A command this file stops can hold its folder for a moment on Windows (EBUSY), so removal retries.
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

async function environment() {
  const root = await mkdtemp(join(tmpdir(), "tesota-host-env-"));
  roots.push(root);
  return { root, environment: await hostProvider.prepare(root) };
}

it("declares that it isolates nothing", () => {
  expect(hostProvider.guarantees).toEqual({ filesystem: "host", network: "open", secrets: "none", resources: "unbounded" });
});

it("streams output and reports the exit code", async () => {
  const { root, environment: host } = await environment();
  let output = "";
  const result = await host.run("echo hello && exit 4", { cwd: root, onOutput: (chunk) => { output += chunk.toString(); } });
  expect(result).toEqual({ outcome: "exited", exitCode: 4 });
  expect(output).toContain("hello");
});

it("adds variables on top of the inherited environment", async () => {
  const { root, environment: host } = await environment();
  let output = "";
  await host.run("echo \"$TESOTA_PROBE:${PATH:+path}\"", { cwd: root, env: { TESOTA_PROBE: "set" },
    onOutput: (chunk) => { output += chunk.toString(); } });
  expect(output.trim()).toBe("set:path");
});

it("reports timeouts and cancellation instead of an exit code", async () => {
  const { root, environment: host } = await environment();
  const sleep = "node -e \"setTimeout(() => {}, 30000)\"";
  await expect(host.run(sleep, { cwd: root, timeoutSeconds: 1, onOutput: () => {} }))
    .resolves.toEqual({ outcome: "timed_out", exitCode: null });
  const cancellation = new AbortController();
  const running = host.run(sleep, { cwd: root, signal: cancellation.signal, onOutput: () => {} });
  setTimeout(() => { cancellation.abort(); }, 300);
  await expect(running).resolves.toEqual({ outcome: "cancelled", exitCode: null });
});

it("reports a missing working directory as not started", async () => {
  const { root, environment: host } = await environment();
  await expect(host.run("echo hi", { cwd: join(root, "missing"), onOutput: () => {} }))
    .resolves.toEqual({ outcome: "not_started", exitCode: null });
});
