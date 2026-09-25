import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_SESSION_STORE_ROOT, isRepositoryShellOpen, referencedWorkspaces } from "./shell-session-store.js";
import { Workspace } from "./workspace.js";
import { DEFAULT_WORKSPACES_ROOT, listWorkspaceCheckouts } from "./workspace-checkout.js";

export type PruneReason = "incomplete" | "unreadable" | "unused" | "scratch";
export type KeepReason = "in_use" | "pending_changes" | "shell_open" | "recent";

const scratchGraceMs = 10 * 60 * 1000;

export interface PrunePlan {
  readonly remove: readonly { readonly directory: string; readonly reason: PruneReason }[];
  readonly keep: readonly { readonly directory: string; readonly reason: KeepReason }[];
}

/** Whether a workspace holds work that was never applied or rejected. Unknown counts as pending. */
async function hasPendingChanges(directory: string): Promise<boolean> {
  try { return (await Workspace.open(directory)).snapshot().changes.length > 0; }
  catch { return true; }
}

/**
 * Decide which workspaces can be removed. A workspace is kept while a saved
 * session references it, while its repository has an open shell, or while it
 * holds pending changes; incomplete creations and leftover scratch are removed.
 */
export async function planWorkspacePrune(workspacesRoot: string = DEFAULT_WORKSPACES_ROOT,
  storeRoot: string = DEFAULT_SESSION_STORE_ROOT): Promise<PrunePlan> {
  const referenced = referencedWorkspaces(storeRoot);
  const remove: { directory: string; reason: PruneReason }[] = [];
  const keep: { directory: string; reason: KeepReason }[] = [];
  for (const entry of await listWorkspaceCheckouts(workspacesRoot)) {
    if (entry.kind === "scratch") {
      // A workspace being created right now owns a recent scratch directory.
      const recent = Date.now() - (await lstat(entry.directory)).mtimeMs < scratchGraceMs;
      if (recent) keep.push({ directory: entry.directory, reason: "recent" });
      else remove.push({ directory: entry.directory, reason: "scratch" });
      continue;
    }
    if (entry.kind === "unreadable") { remove.push({ directory: entry.directory, reason: "unreadable" }); continue; }
    if (isRepositoryShellOpen(entry.source, storeRoot)) { keep.push({ directory: entry.directory, reason: "shell_open" }); continue; }
    if (entry.state !== "ready") { remove.push({ directory: entry.directory, reason: "incomplete" }); continue; }
    if (referenced.has(resolve(entry.directory))) { keep.push({ directory: entry.directory, reason: "in_use" }); continue; }
    if (await hasPendingChanges(entry.directory)) { keep.push({ directory: entry.directory, reason: "pending_changes" }); continue; }
    remove.push({ directory: entry.directory, reason: "unused" });
  }
  return { remove, keep };
}

export async function removeWorkspaces(plan: PrunePlan): Promise<void> {
  for (const entry of plan.remove) await rm(entry.directory, { recursive: true, force: true, maxRetries: 3 });
}

const reasonText: Readonly<Record<PruneReason | KeepReason, string>> = {
  incomplete: "creation did not finish", unreadable: "record unreadable", unused: "no session uses it",
  scratch: "leftover temporary files", in_use: "a saved session uses it", pending_changes: "has unapplied changes",
  shell_open: "its repository has an open shell", recent: "created in the last ten minutes",
};

export function formatPrunePlan(plan: PrunePlan): string {
  const lines = [
    ...plan.remove.map((entry) => `remove  ${entry.directory}  (${reasonText[entry.reason]})`),
    ...plan.keep.map((entry) => `keep    ${entry.directory}  (${reasonText[entry.reason]})`),
  ];
  return lines.length === 0 ? "No workspaces found.\n" : `${lines.join("\n")}\n`;
}
