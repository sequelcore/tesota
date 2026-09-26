import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as z from "zod";
import { isNetworkDestination } from "./execution-environment.js";
import { MEASUREMENTS_KEPT, type ReviewMeasurement, withMeasurement } from "./review-forecast.js";
import type { TranscriptEntry } from "./tesota-shell-transcript.js";

const text = z.string().max(2_000_000);
const changeSchema = z.strictObject({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
  lines: z.array(z.string().max(400)).max(8) });
const entrySchema: z.ZodType<TranscriptEntry> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), text }),
  z.strictObject({ kind: z.literal("agent"), text }),
  z.strictObject({ kind: z.literal("notice"), text, tone: z.enum(["info", "warning", "success"]) }),
  z.strictObject({ kind: z.literal("tool"), tool: z.string().max(100), subject: z.string().max(10_000), failed: z.boolean(),
    change: changeSchema.optional() }),
  z.strictObject({ kind: z.literal("review"), title: z.string().max(100), text }),
]);
const inspectionSchema: z.ZodType<{ title: string; summary: string; detail: string }> =
  z.strictObject({ title: z.string().max(100), summary: z.string().max(10_000),
    detail: z.string().max(2_000_000) });
const sessionSchema: z.ZodType<{ id: string; title: string;
  engineId: string; entries: TranscriptEntry[];
  inspections: { title: string; summary: string; detail: string }[];
  workspace: string | null;
  interrupted: boolean; blocked: boolean }> =
    z.strictObject({ id: z.string().min(1), title: z.string().min(1).max(100),
      engineId: z.uuid(), entries: z.array(entrySchema), inspections: z.array(inspectionSchema),
      workspace: z.string().min(1).nullable(),
      interrupted: z.boolean(), blocked: z.boolean() });
const measurementSchema: z.ZodType<ReviewMeasurement> = z.strictObject({ at: z.iso.datetime(),
  depth: z.enum(["standard", "deep"]), correction: z.boolean(), durationMs: z.number().nonnegative(),
  tokens: z.number().nonnegative() });
const snapshotVersion = 5;
// `reviews` arrived after version 5 and is optional, so saved sessions survive; a missing list is empty.
const snapshotSchema: z.ZodType<{ format: "tesota-shell-sessions"; version: typeof snapshotVersion; source: string;
  checks: string[] | null; network: string[]; reviews?: ReviewMeasurement[] | undefined;
  sessions: z.infer<typeof sessionSchema>[] }> =
    z.strictObject({ format: z.literal("tesota-shell-sessions"), version: z.literal(snapshotVersion),
      source: z.string(), checks: z.array(z.string().min(1).max(1000)).max(20).nullable(),
      network: z.array(z.string().refine(isNetworkDestination)).max(200),
      reviews: z.array(measurementSchema).max(MEASUREMENTS_KEPT).optional(),
      sessions: z.array(sessionSchema) });
export type ShellSessionRecord = z.infer<typeof sessionSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

export interface ShellSessionStore {
  list(): readonly ShellSessionRecord[];
  create(): ShellSessionRecord;
  remove(id: string): void;
  append(id: string, entry: TranscriptEntry): void;
  inspect(id: string, inspection: { title: string; summary: string; detail: string }): void;
  setWorkspace(id: string, directory: string): void;
  /** Check commands the operator approved for this repository, or null before the first choice. */
  checks(): readonly string[] | null;
  setChecks(commands: readonly string[]): void;
  /** Network destinations the operator allowed for every session of this repository. */
  allowedNetwork(): readonly string[];
  allowNetwork(destinations: readonly string[]): void;
  /** This repository's measured review steps, newest last, from which reviews are forecast. */
  reviewMeasurements(): readonly ReviewMeasurement[];
  recordReviewMeasurement(measurement: ReviewMeasurement): void;
  markActive(id: string, active: boolean): void;
  block(id: string): void;
  rotateEngine(id: string): string;
  close(): void;
}

function readSnapshot(path: string, source: string): Snapshot {
  const empty: Snapshot = { format: "tesota-shell-sessions", version: snapshotVersion, source, checks: null,
    network: [], sessions: [] };
  if (!existsSync(path)) return empty;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  // Snapshots from earlier versions are discarded; the next save replaces the file.
  const version: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "version") : undefined;
  if (typeof version === "number" && version < snapshotVersion) return empty;
  return snapshotSchema.parse(value);
}

export const DEFAULT_SESSION_STORE_ROOT: string = join(homedir(), ".tesota", "shell-sessions");

function storePath(source: string, root: string): string {
  return join(root, createHash("sha256").update(resolve(source).toLocaleLowerCase("en-US")).digest("hex") + ".json");
}

/** Whether a live process holds the lock; an unreadable lock counts as held. */
function lockHeld(lockPath: string): boolean {
  let text: string;
  try { text = readFileSync(lockPath, "utf8"); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    return true;
  }
  const owner = Number(text);
  if (!Number.isSafeInteger(owner) || owner <= 0) return true;
  try { process.kill(owner, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

/** Whether a Tesota shell is currently open for a repository. */
export function isRepositoryShellOpen(source: string, root: string = DEFAULT_SESSION_STORE_ROOT): boolean {
  return lockHeld(`${storePath(source, root)}.lock`);
}

/** Workspace directories referenced by any saved session, across all repositories. */
export function referencedWorkspaces(root: string = DEFAULT_SESSION_STORE_ROOT): ReadonlySet<string> {
  const referenced = new Set<string>();
  let names: string[];
  try { names = readdirSync(root); } catch { return referenced; }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(join(root, name), "utf8")));
    if (!parsed.success) continue;
    for (const session of parsed.data.sessions) if (session.workspace !== null) referenced.add(resolve(session.workspace));
  }
  return referenced;
}

/**
 * The store records the human transcript, workspace locations, the
 * repository's approved check commands, allowed network destinations and
 * measured review costs; never command approvals or check results.
 */
export function openShellSessionStore(sourceDirectory: string,
  root: string = DEFAULT_SESSION_STORE_ROOT): ShellSessionStore {
  const source = resolve(sourceDirectory);
  const path = storePath(source, root);
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch {
    if (lockHeld(lockPath)) throw new Error("This repository already has an open Tesota shell. Close it before opening another.");
    unlinkSync(lockPath);
    lock = openSync(lockPath, "wx", 0o600);
  }
  try {
    writeFileSync(lock, String(process.pid));
    const snapshot = readSnapshot(path, source);
    if (snapshot.source !== source) throw new Error("Saved Tesota sessions belong to another repository");
    const sessions = new Map(snapshot.sessions.map((session) => [session.id,
      { ...session, entries: [...session.entries], inspections: [...session.inspections] }]));
    if (sessions.size !== snapshot.sessions.length) throw new Error("Duplicate saved Tesota session");
    let checks = snapshot.checks;
    let network = snapshot.network;
    let reviews: readonly ReviewMeasurement[] = snapshot.reviews ?? [];
    let closed = false;
    const save = (): void => {
      if (closed) throw new Error("Tesota session store closed");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ format: "tesota-shell-sessions", version: snapshotVersion,
          source, checks, network, reviews, sessions: [...sessions.values()] }) + "\n", { encoding: "utf8", mode: 0o600 });
        renameSync(temporary, path);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    };
    const find = (id: string): ShellSessionRecord => {
      const session = sessions.get(id);
      if (session === undefined) throw new Error("Saved Tesota session unavailable");
      return session;
    };
    return {
      list: () => [...sessions.values()],
      create: () => {
        const numbers = [...sessions.values()].map((existing) => Number(/^Session (\d+)$/u.exec(existing.title)?.[1] ?? 0));
        const session = { id: randomUUID(), title: `Session ${Math.max(0, ...numbers) + 1}`,
          engineId: randomUUID(), entries: [], inspections: [], workspace: null,
          interrupted: false, blocked: false };
        sessions.set(session.id, session);
        try { save(); } catch (error) { sessions.delete(session.id); throw error; }
        return session;
      },
      remove: (id) => {
        const session = find(id);
        sessions.delete(id);
        try { save(); } catch (error) { sessions.set(id, session); throw error; }
      },
      append: (id, entry) => {
        const session = find(id);
        session.entries.push(entrySchema.parse(entry));
        try { save(); } catch (error) { session.entries.pop(); throw error; }
      },
      inspect: (id, inspection) => {
        const session = find(id);
        session.inspections.push(inspectionSchema.parse(inspection));
        try { save(); } catch (error) { session.inspections.pop(); throw error; }
      },
      setWorkspace: (id, directory) => {
        const session = find(id);
        const previous = session.workspace;
        session.workspace = directory;
        try { save(); } catch (error) { session.workspace = previous; throw error; }
      },
      checks: () => checks,
      setChecks: (commands) => {
        const previous = checks;
        checks = [...commands];
        try { save(); } catch (error) { checks = previous; throw error; }
      },
      allowedNetwork: () => network,
      allowNetwork: (destinations) => {
        const previous = network;
        network = [...new Set([...network, ...destinations.map((destination) => z.string()
          .refine(isNetworkDestination).parse(destination))])];
        try { save(); } catch (error) { network = previous; throw error; }
      },
      reviewMeasurements: () => reviews,
      recordReviewMeasurement: (measurement) => {
        const previous = reviews;
        reviews = withMeasurement(reviews, measurementSchema.parse(measurement));
        try { save(); } catch (error) { reviews = previous; throw error; }
      },
      markActive: (id, active) => {
        const session = find(id);
        const previous = session.interrupted;
        session.interrupted = active;
        try { save(); } catch (error) { session.interrupted = previous; throw error; }
      },
      block: (id) => {
        const session = find(id);
        session.blocked = true;
        save();
      },
      rotateEngine: (id) => {
        const session = find(id);
        const previous = session.engineId;
        session.engineId = randomUUID();
        try { save(); } catch (error) { session.engineId = previous; throw error; }
        return session.engineId;
      },
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(lock);
        unlinkSync(lockPath);
      },
    };
  } catch (error) {
    closeSync(lock);
    unlinkSync(lockPath);
    throw error;
  }
}
