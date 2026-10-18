import { join } from "node:path";
import { git } from "../../../src/git.ts";
import { takeSnapshot } from "../../../src/snapshot.ts";
import { workspaceUnits } from "../../../src/workspace.ts";
import { withLockWhile } from "./session-lock.ts";

/**
 * One unit of the session's folder as a request found it: a repository's
 * commit `HEAD` named, null before its first commit; a snapshot of a folder
 * in no repository, with the files left out for their size; or why there is
 * neither. `folder` is relative to the session's folder, as in
 * `workspaceUnits`.
 */
export type BaseUnit =
  | { readonly folder: string; readonly kind: "commit"; readonly commit: string | null }
  | { readonly folder: string; readonly kind: "snapshot"; readonly commit: string; readonly tooLarge: readonly string[] }
  | { readonly folder: string; readonly kind: "refused"; readonly reason: string };

/** What a request is measured against: each unit of the session's folder; none when the folder cannot be read. */
export interface Base {
  readonly units: readonly BaseUnit[];
}

/** A repository's base: its commit, null before the first one, or refused when Git cannot read it. */
async function repositoryBase(folder: string, root: string): Promise<BaseUnit> {
  const commit = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  if (commit !== undefined && commit !== "") return { folder, kind: "commit", commit };
  if (await git(root, ["rev-parse", "--git-dir"]) !== undefined) return { folder, kind: "commit", commit: null };
  return { folder, kind: "refused", reason: "Git could not read the repository" };
}

/**
 * The base of a request in `cwd` (#437), taken before any tool runs, with
 * the gate's units: a repository's commit, and for each folder in no
 * repository Tesota's snapshot of it. Verification reads this record and
 * never rebuilds the base after the agent changed the files.
 */
export async function captureBase(cwd: string, signal?: AbortSignal): Promise<Base> {
  const units = workspaceUnits(cwd);
  const workspace = units.some(({ folder }) => folder !== "");
  const found: BaseUnit[] = [];
  for (const { folder, repository } of units) {
    const root = join(cwd, folder);
    if (repository) { found.push(await repositoryBase(folder, root)); continue; }
    const snapshot = await takeSnapshot(root, workspace && folder === "", withLockWhile, undefined, signal);
    found.push("refused" in snapshot ? { folder, kind: "refused", reason: snapshot.refused }
      : { folder, kind: "snapshot", commit: snapshot.base, tooLarge: snapshot.tooLarge });
  }
  return { units: found };
}
