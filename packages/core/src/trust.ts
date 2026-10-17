import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { withLock } from "./session-lock.ts";
import { writeWholeJson } from "./whole-file.ts";

/**
 * What of a project runs its own commands, and so runs only once the
 * operator trusts it as it is now: its hooks (#457) and its MCP servers (#459).
 */
export type Trusted = "hooks" | "mcp";

/** A hash of what a project would run, which its trust is given to: any change asks again. */
export const trustHash = (what: unknown): string => createHash("sha256").update(JSON.stringify(what)).digest("hex");

const trustFile = (home: string): string => join(home, "trust.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A project by its one real name, in one case on Windows, so the same checkout is trusted however it is reached. */
function projectKey(root: string): string {
  let named = root;
  try { named = realpathSync.native(root); } catch { /* as given */ }
  return process.platform === "win32" ? named.toLowerCase() : named;
}

/** Whether the operator trusted the `kind` of the project at `root` as it is now (`hash`). */
export function trusted(root: string, kind: Trusted, hash: string, home: string = tesotaHome()): boolean {
  try {
    const trust: unknown = JSON.parse(readFileSync(trustFile(home), "utf8"));
    const project = isRecord(trust) && isRecord(trust["projects"]) ? trust["projects"][projectKey(root)] : undefined;
    return isRecord(project) && project[kind] === hash;
  } catch {
    return false;
  }
}

/** Records that the operator trusts the `kind` of the project at `root` as it is now, keeping what else of it they trust. */
export function trust(root: string, kind: Trusted, hash: string, home: string = tesotaHome()): void {
  // Read, changed and written under a lock, so two shells trusting at once each keep the other's.
  withLock(`${trustFile(home)}.lock`, () => {
    let file: Record<string, unknown> = {};
    try {
      const read: unknown = JSON.parse(readFileSync(trustFile(home), "utf8"));
      if (isRecord(read)) file = read;
    } catch { /* none yet */ }
    const projects = isRecord(file["projects"]) ? file["projects"] : {};
    const key = projectKey(root);
    const project = isRecord(projects[key]) ? projects[key] : {};
    writeWholeJson(trustFile(home), { ...file, projects: { ...projects, [key]: { ...project, [kind]: hash } } });
  });
}
