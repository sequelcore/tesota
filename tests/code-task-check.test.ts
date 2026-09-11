import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { CODE_CHECK_IMAGE, CODE_TASK_MARKER, checkCodeTask } from "../src/code-task-check.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const windowsIt = it.runIf(process.platform === "win32");
afterEach(() => vi.resetAllMocks());
const source = "// preserved\n" + CODE_TASK_MARKER + "\n return true;\n}\n";
function response(stdout: string, status = 0) {
  return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
}
windowsIt("runs only in the pinned restricted container, with no host mounts or inherited credentials", () => {
  spawn.mockReturnValueOnce(response('{"failures":[]}')).mockReturnValueOnce(response(""));
  expect(checkCodeTask(source, source).status).toBe("passed");
  const [command, args, options] = spawn.mock.calls[0] ?? [];
  expect(command).toBe("docker");
  expect(args).toEqual(expect.arrayContaining([CODE_CHECK_IMAGE, "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--user=65534:65534", "--memory=128m", "--pids-limit=32", "--pull=never"]));
  expect(args).not.toEqual(expect.arrayContaining(["--mount", "-v", "--privileged", "--env-file"]));
  expect(options).toMatchObject({ shell: false, timeout: 15_000, maxBuffer: 16_384 });
  expect(Object.keys(options?.env ?? {}).every((key) => ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(key))).toBe(true);
  expect(spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["rm", "--force"]));
  expect(spawn.mock.calls[1]?.[1]?.at(-1)).toBe(args?.[(args?.indexOf("--name") ?? -1) + 1]);
});
it("rejects edits outside the function before executing anything", () => {
  expect(checkCodeTask("changed\n" + source, source).status).toBe("check_failed");
  expect(spawn).not.toHaveBeenCalled();
});
windowsIt.each(['{"failures":["baseline mismatch"]}', "invalid", '{"failures":[1]}'])("does not accept failed or invalid output: %s", (stdout) => {
  spawn.mockReturnValueOnce(response(stdout)).mockReturnValueOnce(response(""));
  expect(checkCodeTask(source, source).status).toBe("check_failed");
});
windowsIt("cleans up a timed out container and does not report a pass", () => {
  spawn.mockReturnValueOnce({ ...response(""), status: null, error: new Error("SYNTHETIC_PRIVATE") }).mockReturnValueOnce(response(""));
  const result = checkCodeTask(source, source);
  expect(result.status).toBe("check_failed");
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
  expect(spawn).toHaveBeenCalledTimes(2);
});
windowsIt("does not return check evidence when container cleanup is unconfirmed", () => {
  spawn.mockReturnValueOnce(response('{"failures":[]}')).mockReturnValueOnce(response("", 1));
  expect(() => checkCodeTask(source, source)).toThrow("cleanup unconfirmed");
});
