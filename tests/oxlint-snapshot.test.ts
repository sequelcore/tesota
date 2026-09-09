import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assessApplicability, configuredOxlint, runOxlint } from "../src/verification/oxlint.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5000,
}).trim();

it("checks the captured bytes when the original changes at the process-start boundary", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "tesota-snapshot-test-"));
  const file = join(root, "original.test.ts");
  const original = Buffer.from("debugger;\r\n");
  let snapshot: string | undefined;
  try {
    await writeFile(file, original);
    const check = configuredOxlint(root, bun);
    vi.mocked(spawn).mockImplementationOnce((...args) => {
      // A synchronous barrier after snapshot creation and before real Oxlint
      // can read anything. No timing assumption or fake producer report.
      const cwd = args[2]?.cwd;
      if (typeof cwd !== "string") throw new Error("Expected private working directory");
      snapshot = join(cwd, "original.test.ts");
      expect(readFileSync(snapshot)).toEqual(original);
      writeFileSync(file, "export const nowValid = 1;\n");
      return actual.spawn(...args);
    });
    const result = await runOxlint(check, file);
    expect(result).toMatchObject({ status: "check_failed", file,
      diagnostics: [{ rule: "eslint(no-debugger)", line: 1, column: 1 }],
      binding: { source: { file, sha256: createHash("sha256").update(original).digest("hex") } } });
    expect((await assessApplicability(result, check)).status).toBe("stale");
    expect(snapshot).toBeDefined();
    const removedSnapshot = snapshot;
    if (removedSnapshot !== undefined) expect(() => readFileSync(removedSnapshot)).toThrow();
  } finally {
    vi.mocked(spawn).mockImplementation(actual.spawn);
    await rm(root, { recursive: true, force: true });
  }
});

it("makes a real result unavailable when a later source read is denied", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "tesota-unreadable-test-"));
  try {
    const file = join(root, "source.ts");
    await writeFile(file, "export const value = 1;\n");
    const check = configuredOxlint(root, bun);
    const result = await runOxlint(check, file);
    expect(result.status).toBe("passed");
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
    expect((await assessApplicability(result, check)).status).toBe("unavailable");
    expect(result.status).toBe("passed");
  } finally {
    vi.mocked(open).mockImplementation(actual.open);
    await rm(root, { recursive: true, force: true });
  }
});
