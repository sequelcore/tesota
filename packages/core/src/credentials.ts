import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { withLockWhile } from "./session-lock.ts";
import { parseJson } from "../../../src/json.ts";
import { writeWholeJson } from "./whole-file.ts";

/** How long a write waits for another writer's lock before it gives up. */
const lockWaitMs = 10_000;

type Stored = Record<string, Credential>;

const isCredential = (value: unknown): value is Credential => typeof value === "object" && value !== null
  && ["api_key", "oauth"].includes(String(Reflect.get(value, "type")));

/** The credentials in `path`, by provider; none when it does not exist yet. A file that is not one is a storage failure. */
function readStored(path: string): Stored {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = parseJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} does not hold credentials.`);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Credential] => isCredential(entry[1])));
}

/**
 * The engine's credentials (#443), one per provider id (including named instances), in `~/.tesota/auth.json`
 * unless given another file; Pi's are never read. Every write is a
 * read-modify-write under an operating-system lock, as pi-ai's store
 * requires, so an OAuth refresh in one process cannot race another's.
 */
export function fileCredentialStore(path: string = join(tesotaHome(), "auth.json")): CredentialStore {
  const lockPath = `${path}.lock`;
  /** Writes in this process wait for each other before taking the file lock. */
  let queue: Promise<unknown> = Promise.resolve();
  async function change<T>(options: AuthOperationOptions | undefined, fn: (stored: Stored) => Promise<{ next?: Stored; result: T }>): Promise<T> {
    const run = queue.then(async () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      return withLockWhile(lockPath, async () => {
        const { next, result } = await fn(readStored(path));
        // Readable by its owner only, where the system has modes.
        if (next !== undefined) writeWholeJson(path, next, 0o600);
        return result;
      }, lockWaitMs, options?.signal);
    });
    queue = run.catch(() => undefined);
    return run;
  }
  return {
    // Async, so a broken file rejects as pi-ai expects of a storage failure.
    read: async (providerId) => readStored(path)[providerId],
    list: async () => Object.entries(readStored(path)).map(([providerId, { type }]): CredentialInfo => ({ providerId, type })),
    modify: (providerId, fn, options) => change(options, async (stored) => {
      const next = await fn(stored[providerId]);
      return next === undefined ? { result: stored[providerId] } : { next: { ...stored, [providerId]: next }, result: next };
    }),
    delete: (providerId, options) => change(options, (stored) => {
      if (!(providerId in stored)) return Promise.resolve({ result: undefined });
      const { [providerId]: _removed, ...rest } = stored;
      return Promise.resolve({ next: rest, result: undefined });
    }),
  };
}
