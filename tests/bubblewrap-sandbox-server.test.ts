import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs the compiled sandbox probe under Node without adjacent modules or dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-standalone-sandbox-"));
  const server = join(root, "server.mjs");
  try {
    await copyFile(resolve("dist/bubblewrap-sandbox-server.js"), server);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [server, "check"], { cwd: root, timeout: 10_000 });
    const checked: unknown = JSON.parse(stdout);
    expect(stderr).toBe("");
    expect(checked).toMatchObject({ type: "checked", problems: expect.any(Array), settings: [],
      versions: expect.stringContaining(`node ${process.version}`) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
