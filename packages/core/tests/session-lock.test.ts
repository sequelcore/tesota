import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSession, SessionLockedError, withLockWhile } from "../src/session-lock.ts";

const path = (): string => join(mkdtempSync(join(tmpdir(), "tesota-core-lock-")), "writer.lock");

test("an async writer waits for the holder, then runs and releases its lock", async () => {
  const file = path();
  const lock = lockSession(file);
  let ran = false;
  const waiting = withLockWhile(file, async () => { ran = true; return 42; }, 1_000);
  try {
    await Bun.sleep(75);
    expect(ran).toBe(false);
  } finally {
    lock.release();
  }
  expect(await waiting).toBe(42);
  lockSession(file).release();
});

for (const waitMs of [0, 60]) {
  test(`an async writer refuses contention after its ${waitMs} ms wait`, async () => {
    const file = path();
    const lock = lockSession(file);
    let ran = false;
    try {
      await expect(withLockWhile(file, async () => { ran = true; }, waitMs)).rejects.toBeInstanceOf(SessionLockedError);
      expect(ran).toBe(false);
    } finally {
      lock.release();
    }
    lockSession(file).release();
  });
}

test("an async writer's wait limits acquisition, not its work", async () => {
  const file = path();
  expect(await withLockWhile(file, async () => {
    await Bun.sleep(60);
    expect(() => lockSession(file)).toThrow(SessionLockedError);
    return 42;
  }, 0)).toBe(42);
  lockSession(file).release();
});

test("an async writer releases on rejection and never retries its work, even a lock error", async () => {
  const file = path();
  const error = new SessionLockedError(file);
  let calls = 0;
  await expect(withLockWhile(file, () => { calls++; return Promise.reject(error); }, 1_000)).rejects.toBe(error);
  expect(calls).toBe(1);
  lockSession(file).release();
});

test("an async writer releases on a synchronous throw and preserves the thrown value", async () => {
  const file = path();
  const error = { refused: "work failed" };
  await expect(withLockWhile(file, () => { throw error; }, 1_000)).rejects.toBe(error);
  lockSession(file).release();
});

test("an async writer refuses an acquisition error other than contention without waiting", async () => {
  const file = join(path(), "missing", "writer.lock");
  const result = withLockWhile(file, async () => "ran", 1_000).catch((error: unknown) => error);
  const error = await Promise.race([result, Bun.sleep(100).then(() => "waited")]);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(SessionLockedError);
});
