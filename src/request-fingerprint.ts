import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { git } from "./git.js";
import { attributePath, fingerprintEligible, historyAttributable } from "./verification/fingerprint-rule.js";

export interface HistoryFacts {
  readonly sameBranch: boolean;
  readonly descends: boolean;
  readonly exclusive: boolean;
  readonly timely: boolean;
}
export type StartState = { readonly status: "known"; readonly head: string | null; readonly history?: HistoryFacts }
  | { readonly status: "unknown"; readonly reason: string };
/** Shared by selection and every receipt surface; missing captures cannot establish contribution. */
export function attributionResolved(base: string | null, start: StartState | undefined, end: StartState | undefined,
  repository: boolean): boolean {
  return historyAttributable(repository, start?.status === "known", end?.status === "known",
    start?.status === "known" && start.head === base, end?.status === "known" && end.head === base,
    end?.status === "known" && end.history?.sameBranch === true, end?.status === "known" && end.history?.descends === true,
    end?.status === "known" && end.history?.exclusive === true, end?.status === "known" && end.history?.timely === true);
}

export interface UnmeasuredPath { readonly path: string; readonly reason: string }
export type Fingerprint = { readonly status: "known"; readonly head: string | null; readonly branch: string;
  readonly blobs: ReadonlyMap<string, string | null>; readonly unmeasured: readonly UnmeasuredPath[] }
  | { readonly status: "unknown"; readonly reason: string };

/** Dirty paths from porcelain v2, including both sides of a rename; a conflict cannot establish a start state. */
function statusPaths(status: string, prefix: string): { paths: string[]; untracked: string[] } | undefined {
  const fields = status.split("\0");
  const paths = new Set<string>();
  const untracked: string[] = [];
  for (let k = 0; k < fields.length; k += 1) {
    const field = fields[k] ?? "";
    if (field.startsWith("u ")) return undefined;
    const path = field.startsWith("1 ") ? field.split(" ").slice(8).join(" ")
      : field.startsWith("2 ") ? field.split(" ").slice(9).join(" ")
        : field.startsWith("? ") ? field.slice(2) : undefined;
    if (path === undefined) continue;
    if (path.startsWith(prefix)) {
      paths.add(path.slice(prefix.length));
      if (field.startsWith("? ")) untracked.push(path.slice(prefix.length));
    }
    if (field.startsWith("2 ")) {
      k += 1;
      const previous = fields[k] ?? "";
      if (previous.startsWith(prefix)) paths.add(previous.slice(prefix.length));
    }
  }
  return { paths: [...paths].sort(), untracked };
}

/** Count nested untracked files together, without treating a tracked ancestor as an untracked directory. */
async function crowdedDirectories(root: string, paths: readonly string[]): Promise<ReadonlySet<string> | undefined> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const candidates = [...counts].filter(([, count]) => count >= 200).map(([dir]) => dir);
  if (candidates.length === 0) return new Set();
  const tracked = await git(root, ["ls-files", "--cached", "-z"]);
  if (tracked === undefined) return undefined;
  const files = tracked.split("\0");
  return new Set(candidates.filter((dir) => !files.some((path) => path.startsWith(`${dir}/`))));
}

/** Blob IDs without writing objects, refs or the index. Git's quoted stdin paths preserve spaces, newlines and non-ASCII names. */
export async function pathBlobs(root: string, paths: readonly string[], prefix: string): Promise<Map<string, string | null> | undefined> {
  const blobs = new Map<string, string | null>();
  const present: string[] = [];
  for (const path of paths) {
    try { await lstat(join(root, path)); present.push(path); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return undefined;
      blobs.set(path, null);
    }
  }
  if (present.length === 0) return blobs;
  const quoted = present.map((path) => `"${[...prefix + path].map((char) => char === '"' || char === "\\" ? `\\${char}`
    : char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}` : char).join("")}"`);
  const output = await git(root, ["hash-object", "--stdin-paths"], quoted.join("\n") + "\n");
  const ids = output?.trim().split(/\r?\n/u);
  if (ids?.length !== present.length) return undefined;
  for (const [k, path] of present.entries()) blobs.set(path, ids[k] ?? null);
  return blobs;
}

/** The repository just before a tool or verification, with optional index refreshes disabled. */
export async function captureFingerprint(root: string): Promise<Fingerprint> {
  const prefix = await git(root, ["rev-parse", "--show-prefix"]);
  const status = await git(root, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--branch", "--", "."]);
  if (status === undefined) return { status: "unknown", reason: "Git could not read the fingerprint's status" };
  if (prefix === undefined) return { status: "unknown", reason: "Git could not read the fingerprint's folder" };
  const listed = statusPaths(status, prefix.trimEnd());
  if (listed === undefined) return { status: "unknown", reason: "the index has unresolved conflicts" };
  const oid = status.split("\0").find((field) => field.startsWith("# branch.oid "))?.slice(13);
  if (oid === undefined) return { status: "unknown", reason: "Git could not read the fingerprint's HEAD" };
  const crowded = await crowdedDirectories(root, listed.untracked);
  if (crowded === undefined) return { status: "unknown", reason: "Git could not read the untracked directories" };
  const untracked = new Set(listed.untracked);
  const unmeasured: UnmeasuredPath[] = [];
  const measured: string[] = [];
  for (const path of listed.paths) {
    if (untracked.has(path) && [...crowded].some((dir) => path.startsWith(`${dir}/`))) {
      unmeasured.push({ path, reason: "directory has 200 or more untracked files" });
      continue;
    }
    try {
      const size = await lstat(join(root, path));
      if (size.size > 10 * 1024 * 1024) { unmeasured.push({ path, reason: "file exceeds 10 MiB" }); continue; }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        return { status: "unknown", reason: `could not measure ${path}` };
      }
    }
    measured.push(path);
  }
  const blobs = await pathBlobs(root, measured, prefix.trimEnd());
  return blobs === undefined ? { status: "unknown", reason: "Git could not hash the fingerprint's paths" }
    : { status: "known", head: oid === "(initial)" ? null : oid,
      branch: status.split("\0").find((field) => field.startsWith("# branch.head "))?.slice(14) ?? "", blobs, unmeasured };
}

/** Read Git facts only; the proved rule owns the attribution decision. Missing reads never grant credit. */
export async function historyFacts(root: string, base: string | null, start: Fingerprint, end: Fingerprint,
  startedAt: string): Promise<HistoryFacts | undefined> {
  if (base === null || start.status !== "known" || end.status !== "known" || end.head === null) return undefined;
  // H descends to HEAD exactly when it is their merge base; no common ancestor at all is a failed read.
  const ancestor = await git(root, ["merge-base", base, end.head]);
  const range = await git(root, ["log", "--no-show-signature", "--format=%H %ct", `${base}..${end.head}`]);
  // Subtract every other branch, remote-tracking ref and tag in one history walk, not one process per commit.
  const unshared = await git(root, ["rev-list", `${base}..${end.head}`, "--not",
    `--exclude=${end.branch}`, "--branches", "--remotes", "--tags"]);
  if (ancestor === undefined || range === undefined || unshared === undefined) return undefined;
  const exclusiveIds = new Set(unshared.trim().split(/\r?\n/u).filter(Boolean));
  let exclusive = true;
  let timely = true;
  const startSecond = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(startSecond)) return undefined;
  for (const line of range.trim().split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]+) (\d+)$/u.exec(line);
    if (match === null) return undefined;
    exclusive &&= exclusiveIds.has(match[1] ?? "");
    timely &&= Number(match[2]) >= startSecond;
  }
  return { sameBranch: start.branch !== "" && start.branch !== "(detached)" && start.branch === end.branch,
    descends: ancestor.trim() === base, exclusive, timely };
}

/** Attribution observes results, not authors. An unreadable end is eligible too, with its reason. */
export function compareFingerprints(start: Fingerprint, end: Fingerprint, committed: readonly string[]):
  { eligible: boolean; changed: string[] | undefined; inherited: string[]; unmeasured: UnmeasuredPath[] } {
  const unmeasured = [...new Map([...(start.status === "known" ? start.unmeasured : []),
    ...(end.status === "known" ? end.unmeasured : [])].map((item) => [item.path, item])).values()];
  if (start.status === "unknown" || end.status === "unknown") {
    return { eligible: fingerprintEligible(false, false, false, unmeasured.length > 0), changed: undefined, inherited: [], unmeasured };
  }
  const omitted = new Set(unmeasured.map(({ path }) => path));
  const inCommit = new Set(committed);
  const changed: string[] = [];
  const inherited: string[] = [];
  let pathChanged = false;
  for (const path of [...new Set([...start.blobs.keys(), ...end.blobs.keys(), ...committed])].sort()) {
    const differs = start.blobs.has(path) !== end.blobs.has(path) || start.blobs.get(path) !== end.blobs.get(path);
    pathChanged ||= differs;
    const attribution = attributePath(!omitted.has(path), differs, inCommit.has(path), start.blobs.has(path));
    if (attribution === "request") changed.push(path);
    if (attribution === "inherited") inherited.push(path);
  }
  return { eligible: fingerprintEligible(true, start.head !== end.head, pathChanged, unmeasured.length > 0),
    changed, inherited, unmeasured };
}
