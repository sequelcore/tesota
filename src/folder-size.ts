import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The bytes the files under `path` hold, counting a symbolic link as itself
 * and never what it points to; 0 when `path` does not exist.
 */
export async function folderSize(path: string): Promise<number> {
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata === undefined) return 0;
  if (!metadata.isDirectory()) return metadata.size;
  const entries = await readdir(path).catch(() => []);
  let total = 0;
  for (const entry of entries) total += await folderSize(join(path, entry));
  return total;
}

/** A size in the largest unit that keeps it at least 1, to one decimal below 10. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
