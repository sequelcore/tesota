import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Another writer holds the session: in this process or another. */
export class SessionLockedError extends Error {
  constructor(path: string) {
    super(`The session is open in another writer (${path} is locked); close it there first.`);
    this.name = "SessionLockedError";
  }
}

export interface SessionLock {
  release(): void;
}

/** Windows' sharing violation: another handle has the file open without sharing it. */
const sharingViolation = 32;

let kernel32: ReturnType<typeof openKernel32> | undefined;
function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}

/**
 * The C libraries that may hold `flock`, in order: macOS's; on Linux glibc's,
 * then musl's, which distributions such as Alpine have instead (#472).
 */
function libcNames(): string[] {
  if (process.platform === "darwin") return ["libSystem.B.dylib"];
  return ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
}

let libc: ReturnType<typeof openLibc> | undefined;
function openLibc() {
  const names = libcNames();
  for (const [index, name] of names.entries()) {
    try {
      return dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols;
    } catch (error) {
      if (index === names.length - 1) throw error;
    }
  }
  throw new Error("No C library to lock with.");
}

/** Whether `CreateFileW` failed: Bun gives its `INVALID_HANDLE_VALUE` as the unsigned 64-bit `0xFFFFFFFFFFFFFFFF`, a bigint. */
const invalid = (handle: unknown): boolean => handle === null || handle === 0xffffffffffffffffn || handle === -1 || handle === 0;

function lockOnWindows(path: string): SessionLock {
  kernel32 ??= openKernel32();
  const name = Buffer.from(`${path}\0`, "utf16le");
  const genericWrite = 0x40000000, openAlways = 4, normal = 0x80;
  const handle = kernel32.CreateFileW(ptr(name), genericWrite, 0, null, openAlways, normal, null);
  if (invalid(handle)) {
    const error = kernel32.GetLastError();
    if (error === sharingViolation) throw new SessionLockedError(path);
    throw new Error(`Could not lock ${path}: Windows error ${error}.`);
  }
  const symbols = kernel32;
  return { release: () => { symbols.CloseHandle(handle); } };
}

function lockWithFlock(path: string): SessionLock {
  libc ??= openLibc();
  const fd = openSync(path, "a");
  const exclusive = 2, nonBlocking = 4;
  if (libc.flock(fd, exclusive | nonBlocking) !== 0) {
    closeSync(fd);
    throw new SessionLockedError(path);
  }
  return { release: () => { closeSync(fd); } };
}

/**
 * The session's one writer (#437), held by the operating system: on Windows
 * a handle to `path` that shares nothing, elsewhere `flock`, both through
 * `bun:ffi` since Bun has no file lock. A second writer, in this process or
 * another, is refused. The system releases the lock when its holder exits
 * or is killed, so no stale lock is left to judge by process ids, as
 * Codex's `writer_lock.rs` does with `try_lock`. The lock file stays.
 */
/**
 * Runs `work` holding the lock at `path`, waiting up to about a second for
 * another holder, in this process or another (#457): a read, change and
 * write of a shared file then never loses another's change.
 */
export function withLock<T>(path: string, work: () => T): T {
  for (let tries = 0; ; tries++) {
    let lock: SessionLock;
    try {
      lock = lockSession(path);
    } catch (error) {
      if (!(error instanceof SessionLockedError) || tries >= 100) throw error;
      Bun.sleepSync(10);
      continue;
    }
    try {
      return work();
    } finally {
      lock.release();
    }
  }
}

/**
 * Runs `work`, which may wait on the network, holding the lock at `path`,
 * waiting up to `waitMs` for another holder in this process or another
 * (#459): an MCP token refresh, which a second at once would spend. A wait
 * that runs out is refused naming the file, and a `signal` that stops ends
 * the wait with its reason; work that already holds the lock runs to its
 * end, so the lock is never released under it.
 */
export async function withLockWhile<T>(path: string, work: () => Promise<T>, waitMs: number, signal?: AbortSignal): Promise<T> {
  const until = Date.now() + waitMs;
  const waiting = Schedule.spaced(50).pipe(Schedule.while(({ input }) =>
    input instanceof SessionLockedError && Date.now() < until && signal?.aborted !== true));
  const acquire = Effect.retry(Effect.try({ try: () => {
    signal?.throwIfAborted();
    return lockSession(path);
  }, catch: (error) => error }), waiting).pipe(Effect.mapError((error) => signal?.aborted === true ? signal.reason as unknown
    : error instanceof SessionLockedError ? new Error(`Another Tesota kept ${path} locked for ${waitMs / 1000} s; try again.`) : error));
  return Effect.runPromise(Effect.acquireUseRelease(acquire,
    () => Effect.tryPromise({ try: work, catch: (error) => error }),
    (lock) => Effect.sync(() => { lock.release(); })));
}

export function lockSession(path: string): SessionLock {
  return process.platform === "win32" ? lockOnWindows(path) : lockWithFlock(path);
}
