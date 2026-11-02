import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The directory holding `.git` at or above this scope, or the scope itself outside Git. No command is run. */
export function checkoutRoot(folder: string): string {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return folder;
  }
}
