import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes `value` to `path` as JSON, whole or not at all: beside it, synced,
 * then renamed over it, so a crash leaves the old file or the new one (#443).
 * `mode` applies where the system has modes, to a file this creates.
 */
export function writeWholeJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const draft = `${path}.new`;
  const fd = openSync(draft, "w", mode);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(draft, path);
}
