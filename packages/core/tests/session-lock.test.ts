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

for (const [waitMs, seconds] of [[0, "0"], [60, "0.06"]] as const) {
  test(`an async writer refuses contention after its ${waitMs} ms wait`, async () => {
    const file = path();
    const lock = lockSession(file);
    let ran = false;
    try {
      await expect(withLockWhile(file, async () => { ran = true; }, waitMs))
        .rejects.toThrow(`Another Tesota kept ${file} locked for ${seconds} s; try again.`);
      expect(ran).toBe(false);
    } finally {
      lock.release();
    }
    lockSession(file).release();
  });
}

for (const alreadyStopped of [false, true]) {
  test(`an async writer rejects with its signal's reason when stopped ${alreadyStopped ? "before" : "while"} waiting`, async () => {
    const file = path();
    const lock = lockSession(file);
    const controller = new AbortController();
    const reason = { stopped: "lock wait" };
    let ran = false;
    try {
      if (alreadyStopped) controller.abort(reason);
      const waiting = withLockWhile(file, async () => { ran = true; }, 1_000, controller.signal);
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(ran).toBe(false);
    } finally {
      lock.release();
    }
    lockSession(file).release();
  });
}

test("an async writer never takes an available lock when its signal already stopped", async () => {
  const file = path();
  const reason = new Error("stopped before acquisition");
  let ran = false;
  await expect(withLockWhile(file, async () => { ran = true; }, 1_000, AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(ran).toBe(false);
  lockSession(file).release();
});

test("an async writer's stop does not interrupt work holding the lock", async () => {
  const file = path();
  const controller = new AbortController();
  expect(await withLockWhile(file, async () => {
    controller.abort();
    await Bun.sleep(60);
    expect(() => lockSession(file)).toThrow(SessionLockedError);
    return 42;
  }, 1_000, controller.signal)).toBe(42);
  lockSession(file).release();
});

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
