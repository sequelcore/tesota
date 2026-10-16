import { isAbsolute, resolve } from "node:path";

/**
 * A path the model gave a tool, resolved against the session's folder with
 * the platform's own rules: relative paths, drive letters and either
 * separator on Windows. A Git Bash path such as `/c/Users` is refused on
 * Windows instead of translated, since it would resolve to `C:\c\Users`.
 */
export function resolveToolPath(cwd: string, path: string): string {
  if (process.platform === "win32" && /^\/[a-zA-Z](\/|$)/.test(path)) {
    throw new Error(`"${path}" is a Git Bash path; on Windows write it as "${path[1]?.toUpperCase()}:${path.slice(2) || "\\"}".`);
  }
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
