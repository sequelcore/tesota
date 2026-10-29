import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { engineOf } from "../src/engine-name.js";
import { hangingFilter } from "./hanging-git.js";

const scratch = mkdtempSync(join(tmpdir(), "tesota-engine-"));
// Windows can retain directory handles briefly after the Git/filter processes exit.
// Bound cleanup retries with the isolated run's margin (scripts/isolated.ts); persistent failures still fail the suite.
afterAll(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); });

function checkout(name: string): { folder: string; head: string } {
  const folder = join(scratch, name);
  mkdirSync(folder);
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: folder, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(folder, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return { folder, head: git("rev-parse", "--short=8", "HEAD") };
}

describe("the engine a receipt names (#639)", () => {
  it("names a source run by the commit of Tesota's own checkout", async () => {
    const { folder, head } = checkout("clean");
    expect(await engineOf("0.1.0-alpha.3", { released: false, folder })).toBe(`0.1.0-alpha.3+${head}`);
  });

  it("marks a checkout with changes as dirty", async () => {
    const { folder, head } = checkout("dirty");
    writeFileSync(join(folder, "a.txt"), "changed\n");
    expect(await engineOf("0.1.0-alpha.3", { released: false, folder })).toBe(`0.1.0-alpha.3+${head}.dirty`);
  });

  it("marks a new untracked file dirty even when Git is set to hide them", async () => {
    const { folder, head } = checkout("untracked");
    execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: folder });
    writeFileSync(join(folder, "new.txt"), "new\n");
    expect(await engineOf("0.1.0-alpha.3", { released: false, folder })).toBe(`0.1.0-alpha.3+${head}.dirty`);
  });

  it("says the commit is unknown when it cannot be read", async () => {
    const folder = join(scratch, "not-a-checkout");
    mkdirSync(folder);
    expect(await engineOf("0.1.0-alpha.3", { released: false, folder })).toBe("0.1.0-alpha.3+unknown");
  });

  it("says unknown at its limit when Git hangs, and stops that Git with every process it started (#648)", async () => {
    const { folder } = checkout("hanging");
    const { pids, release } = hangingFilter(folder, "a.txt filter=hang\n");
    // Same size as "a\n", so Git must read the content, through the filter, to know whether it changed.
    writeFileSync(join(folder, "a.txt"), "b\n");
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let started: number[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let named: string | undefined;
      void engineOf("0.1.0-alpha.3", { released: false, folder }).then((engine) => { named = engine; });
      for (const begun = performance.now(); started.length === 0 && performance.now() - begun < 20_000;) {
        try { started = existsSync(pids) ? JSON.parse(readFileSync(pids, "utf8")) as number[] : []; } catch { /* still being written */ }
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(started).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(named).toBe("0.1.0-alpha.3+unknown");
      vi.useRealTimers();
      for (const end = Date.now() + 5_000; started.some(alive) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(started.filter(alive)).toEqual([]);
    } finally {
      vi.useRealTimers();
      release();
      for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  }, 40_000);

  it("keeps a released binary's plain version", async () => {
    const { folder } = checkout("released");
    expect(await engineOf("0.1.0-alpha.3", { released: true, folder })).toBe("0.1.0-alpha.3");
  });
});
