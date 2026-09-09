import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { configuredOxlint, runOxlint } from "../src/verification/oxlint.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => { vi.restoreAllMocks(); spawn.mockReset(); });

it("does not treat a successful kill request as observed process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-settlement-test-"));
  let retained: string | undefined;
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    const file = join(root, "source.ts");
    await writeFile(file, "export const value = 1;\n");
    const result = await runOxlint({
      ...configuredOxlint(root, process.execPath), timeoutMs: 10, terminationWaitMs: 10,
    }, file);
    expect(result).toMatchObject({
      status: "execution_failed", reason: "timeout", process: "unconfirmed", pid: 123456,
    });
    expect(process.platform === "win32" ? child.kill : kill).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
    if (result.status !== "execution_failed") throw new Error("Expected unsettled process");
    retained = result.retainedDirectory;
    expect(retained).toBeDefined();
    if (retained !== undefined) expect(await readFile(join(retained, "profile.json"), "utf8")).toContain("no-debugger");
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }));
  } finally {
    // This test created no real process; its retained directory is safe to reclaim.
    if (retained !== undefined) await rm(retained, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
