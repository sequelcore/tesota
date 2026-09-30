import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { heldForWorkspace, releaseWorkspace } from "./execution-providers.js";
import { folderSize, formatSize } from "./folder-size.js";
import { DEFAULT_SESSION_STORE_ROOT, isRepositoryShellOpen, referencedWorkspaces } from "./shell-session-store.js";
import { DEFAULT_SOURCE_SESSIONS_ROOT, SourceSession } from "./source-session.js";
import { DEFAULT_SOURCES_ROOT, listShadows } from "./source-shadow.js";
import { Workspace } from "./workspace.js";
import { DEFAULT_WORKSPACES_ROOT, listWorkspaceCheckouts } from "./workspace-checkout.js";

export type PruneReason = "incomplete" | "unreadable" | "unused" | "source_gone";
export type KeepReason = "in_use" | "pending_changes" | "shell_open";

export interface PrunePlan {
  readonly remove: readonly { readonly directory: string; readonly reason: PruneReason }[];
  readonly keep: readonly { readonly directory: string; readonly reason: KeepReason }[];
  /** Shadow repositories whose source no longer exists, or whose record is unreadable, and that no kept workspace uses. */
  readonly shadows: readonly { readonly directory: string; readonly reason: "source_gone" | "unreadable" }[];
  /**
   * Records of sessions that worked in the source and that no saved session
   * uses, such as one a crash left; their changes are in the operator's files,
   * and removing the record only ends the chance to revert them from Tesota.
   */
  readonly sessions: readonly { readonly directory: string; readonly reason: "unused" | "unreadable" }[];
}

/** Shadow repositories whose source no longer exists, or whose record is unreadable, that nothing kept needs. */
async function planShadows(root: string, kept: ReadonlySet<string>): Promise<PrunePlan["shadows"]> {
  const shadows: { directory: string; reason: "source_gone" | "unreadable" }[] = [];
  for (const shadow of await listShadows(root)) {
    if (kept.has(resolve(shadow.directory))) continue;
    if (shadow.source === undefined) shadows.push({ directory: shadow.directory, reason: "unreadable" });
    else if (!existsSync(shadow.source)) shadows.push({ directory: shadow.directory, reason: "source_gone" });
  }
  return shadows;
}

/** Sessions in the source that no saved session uses, and the shadows the used ones need. */
async function planSourceSessions(root: string, referenced: ReadonlySet<string>):
  Promise<{ remove: { directory: string; reason: "unused" | "unreadable" }[]; shadows: string[] }> {
  let names: string[];
  try { names = await readdir(root); } catch { return { remove: [], shadows: [] }; }
  const remove: { directory: string; reason: "unused" | "unreadable" }[] = [];
  const shadows: string[] = [];
  for (const name of names.filter((entry) => /^[0-9a-f-]{36}$/u.test(entry)).sort()) {
    const directory = join(root, name);
    let session: SourceSession | undefined;
    try { session = await SourceSession.open(directory); } catch { session = undefined; }
    if (referenced.has(resolve(directory))) { if (session !== undefined) shadows.push(resolve(session.shadow)); continue; }
    remove.push({ directory, reason: session === undefined ? "unreadable" : "unused" });
  }
  return { remove, shadows };
}

/** Whether a workspace holds work that was never applied or rejected. Unknown counts as pending. */
async function hasPendingChanges(directory: string): Promise<boolean> {
  try { return (await Workspace.open(directory)).snapshot().changes.length > 0; }
  catch { return true; }
}

/**
 * Decide which workspaces can be removed. A workspace is kept while a saved
 * session references it, while its repository has an open shell, or while it
 * holds pending changes; incomplete creations are removed. A shadow
 * repository is removed when its source no longer exists and no kept
 * workspace was cloned from it.
 */
export async function planWorkspacePrune(workspacesRoot: string = DEFAULT_WORKSPACES_ROOT,
  storeRoot: string = DEFAULT_SESSION_STORE_ROOT, sourcesRoot: string = DEFAULT_SOURCES_ROOT,
  sourceSessionsRoot: string = DEFAULT_SOURCE_SESSIONS_ROOT): Promise<PrunePlan> {
  const referenced = referencedWorkspaces(storeRoot);
  const remove: { directory: string; reason: PruneReason }[] = [];
  const keep: { directory: string; reason: KeepReason }[] = [];
  const kept = new Set<string>();
  for (const entry of await listWorkspaceCheckouts(workspacesRoot)) {
    if (entry.kind === "workspace") kept.add(resolve(entry.shadow));
    if (entry.kind === "unreadable") { remove.push({ directory: entry.directory, reason: "unreadable" }); continue; }
    if (isRepositoryShellOpen(entry.source, storeRoot)) { keep.push({ directory: entry.directory, reason: "shell_open" }); continue; }
    if (entry.state !== "ready") { remove.push({ directory: entry.directory, reason: "incomplete" }); continue; }
    if (referenced.has(resolve(entry.directory))) { keep.push({ directory: entry.directory, reason: "in_use" }); continue; }
    if (await hasPendingChanges(entry.directory)) { keep.push({ directory: entry.directory, reason: "pending_changes" }); continue; }
    remove.push({ directory: entry.directory, reason: "unused" });
  }
  // A workspace being removed no longer holds its shadow.
  const removed = new Set(remove.map((entry) => resolve(entry.directory)));
  for (const entry of await listWorkspaceCheckouts(workspacesRoot)) {
    if (entry.kind === "workspace" && removed.has(resolve(entry.directory))) kept.delete(resolve(entry.shadow));
  }
  for (const entry of keep) kept.add(resolve(entry.directory));
  const sourceSessions = await planSourceSessions(sourceSessionsRoot, referenced);
  for (const shadow of sourceSessions.shadows) kept.add(shadow);
  return { remove, keep, shadows: await planShadows(sourcesRoot, kept), sessions: sourceSessions.remove };
}

export async function removeWorkspaces(plan: PrunePlan): Promise<void> {
  for (const entry of plan.remove) {
    await releaseWorkspace(join(entry.directory, "repo"));
    await rm(entry.directory, { recursive: true, force: true, maxRetries: 3 });
  }
  for (const entry of plan.sessions) {
    // Its trees stay pinned in the shadow until its record releases them.
    try { (await SourceSession.open(entry.directory)).discard(); } catch { /* an unreadable record pins nothing it can name */ }
    await rm(entry.directory, { recursive: true, force: true, maxRetries: 3 });
  }
  for (const entry of plan.shadows) await rm(entry.directory, { recursive: true, force: true, maxRetries: 3 });
}

/** What a workspace holds on disk: its folder on this computer, and what each provider keeps for it elsewhere. */
export interface WorkspaceSize {
  readonly here: number;
  readonly elsewhere: readonly { readonly provider: string; readonly bytes: number }[];
}

/** Measure each workspace in the plan, to show beside it; a provider that cannot say is left out, never counted as 0. */
export async function measureWorkspaces(plan: PrunePlan,
  held: (checkout: string) => Promise<WorkspaceSize["elsewhere"]> = heldForWorkspace): Promise<Map<string, WorkspaceSize>> {
  const sizes = new Map<string, WorkspaceSize>();
  for (const entry of [...plan.remove, ...plan.keep]) {
    sizes.set(entry.directory, { here: await folderSize(entry.directory), elsewhere: await held(join(entry.directory, "repo")) });
  }
  return sizes;
}

const sizeText = (size: WorkspaceSize | undefined): string => size === undefined ? ""
  : `; ${formatSize(size.here)} on this computer${size.elsewhere.map((entry) =>
    `, ${formatSize(entry.bytes)} in the ${entry.provider === "wsl" ? "WSL sandbox" : entry.provider}`).join("")}`;

const reasonText: Readonly<Record<PruneReason | KeepReason, string>> = {
  incomplete: "creation did not finish", unreadable: "record unreadable", unused: "no session uses it",
  source_gone: "its source no longer exists",
  in_use: "a saved session uses it", pending_changes: "has unapplied changes",
  shell_open: "its repository has an open shell",
};

export function formatPrunePlan(plan: PrunePlan, sizes: ReadonlyMap<string, WorkspaceSize> = new Map()): string {
  const lines = [
    ...plan.remove.map((entry) => `remove  ${entry.directory}  (${reasonText[entry.reason]}${sizeText(sizes.get(entry.directory))})`),
    ...plan.shadows.map((entry) => `remove  ${entry.directory}  (shadow repository; ${reasonText[entry.reason]})`),
    ...plan.sessions.map((entry) => `remove  ${entry.directory}  (session record; ${entry.reason === "unused"
      ? "no session uses it; its changes stay in your files" : reasonText.unreadable})`),
    ...plan.keep.map((entry) => `keep    ${entry.directory}  (${reasonText[entry.reason]}${sizeText(sizes.get(entry.directory))})`),
  ];
  return lines.length === 0 ? "No workspaces found.\n" : `${lines.join("\n")}\n`;
}
