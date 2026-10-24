import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { engineOf } from "../src/engine-name.js";

const scratch = mkdtempSync(join(tmpdir(), "tesota-engine-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

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

  it("keeps a released binary's plain version", async () => {
    const { folder } = checkout("released");
    expect(await engineOf("0.1.0-alpha.3", { released: true, folder })).toBe("0.1.0-alpha.3");
  });
});
