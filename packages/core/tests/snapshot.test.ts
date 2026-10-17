import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../../src/git.ts";
import { captureBase } from "../src/base.ts";

test("two requests snapshot one fresh folder together, each recording its own commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-core-snapshot-"));
  try {
    writeFileSync(join(root, "notes.txt"), "hello\n");
    const bases = await Promise.all([captureBase(root), captureBase(root)]);
    for (const base of bases) {
      expect(base.units).toHaveLength(1);
      const unit = base.units[0];
      expect(unit?.kind).toBe("snapshot");
      if (unit?.kind !== "snapshot") throw new Error("The request has no snapshot");
      expect(unit.tooLarge).toEqual([]);
      expect(await git(root, ["show", `${unit.commit}:notes.txt`])).toBe("hello\n");
    }
    expect((await git(root, ["rev-list", "--all", "--count"]))?.trim()).toBe("2");
    expect(readdirSync(root)).toEqual(["notes.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two processes snapshot one fresh folder together", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-core-snapshot-"));
  writeFileSync(join(root, "notes.txt"), "hello\n");
  const program = `
    import { captureBase } from ${JSON.stringify(new URL("../src/base.ts", import.meta.url).href)};
    await new Promise((resolve) => { process.once("message", resolve); process.send("ready"); });
    const base = await captureBase(process.argv[1]);
    const unit = base.units[0];
    if (unit?.kind !== "snapshot") throw new Error(JSON.stringify(base));
    console.log(unit.commit);
    process.disconnect();
  `;
  const racers = [0, 1].map(() => {
    const ready = Promise.withResolvers<void>();
    const child = Bun.spawn(["bun", "--eval", program, root], {
      stdout: "pipe", stderr: "inherit", env: { ...process.env },
      ipc: (message) => { if (message === "ready") ready.resolve(); },
      onExit: (_child, code) => { if (code !== 0) ready.reject(new Error(`Snapshot process exited with ${code}`)); },
    });
    return { child, ready: ready.promise, output: new Response(child.stdout).text() };
  });
  try {
    await Promise.all(racers.map((racer) => racer.ready));
    for (const { child } of racers) child.send("go");
    expect(await Promise.all(racers.map(({ child }) => child.exited))).toEqual([0, 0]);
    const commits = await Promise.all(racers.map(async ({ output }) => (await output).trim()));
    expect(new Set(commits).size).toBe(2);
    // A third request in this process also registers the snapshot's Git directory for reading it.
    expect((await captureBase(root)).units[0]?.kind).toBe("snapshot");
    for (const commit of commits) expect(await git(root, ["show", `${commit}:notes.txt`])).toBe("hello\n");
    expect((await git(root, ["rev-list", "--all", "--count"]))?.trim()).toBe("3");
    expect(readdirSync(root)).toEqual(["notes.txt"]);
  } finally {
    for (const { child } of racers) child.kill();
    await Promise.all(racers.map(({ child }) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});
