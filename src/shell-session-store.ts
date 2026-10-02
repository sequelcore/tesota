import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as z from "zod";
import { canSaveRule, type CommandRule } from "./command-rules.js";
import { isNetworkDestination } from "./execution-environment.js";
import { SANDBOX_PREFERENCES, type SandboxPreference } from "./execution-providers.js";
import { MAX_PLAN_STEPS, PLAN_STATUSES, type PlanStep } from "./work-plan.js";
import { parseModelChoice } from "./model-roles.js";
import { MEASUREMENTS_KEPT, type ReviewMeasurement, withMeasurement } from "./review-forecast.js";
import { MAX_CHECK_REPORTS, normalizeReportPath } from "./test-report.js";
import { type ApprovedCheck, RELATED_FILES } from "./workspace-checks.js";
import type { TranscriptEntry } from "./tesota-shell-transcript.js";
import { replacesTitle, type TitleSource } from "./verification/session-title-rule.js";
import type { PermissionMode } from "./verification/permission-mode.js";
import { pathKey } from "./source-shadow.js";

const text = z.string().max(2_000_000);
const changeSchema = z.strictObject({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
  lines: z.array(z.string().max(400)).max(8) });
const entrySchema: z.ZodType<TranscriptEntry> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), text }),
  z.strictObject({ kind: z.literal("agent"), text }),
  z.strictObject({ kind: z.literal("notice"), text, tone: z.enum(["info", "warning", "success"]) }),
  z.strictObject({ kind: z.literal("tool"), tool: z.string().max(100), subject: z.string().max(10_000), failed: z.boolean(),
    change: changeSchema.optional(), by: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal("review"), title: z.string().max(100), text }),
  z.strictObject({ kind: z.literal("triage"), model: z.string().max(200), outcome: z.enum(["checked", "skipped", "undecided"]),
    reason: z.string().max(10_000) }),
]);
// An answer check, which changed no files, has no diff.
const inspectionSchema: z.ZodType<{ title: string; summary: string; detail: string; diff?: string | undefined }> =
  z.strictObject({ title: z.string().max(100), summary: z.string().max(10_000),
    detail: z.string().max(2_000_000), diff: z.string().max(2_000_000).optional() });
const agentModelSchema = z.string().refine((value) => parseModelChoice(value) !== undefined, "not a route:model choice");
const planSchema: z.ZodType<PlanStep[]> = z.array(z.strictObject({ step: z.string().min(1).max(2_000),
  status: z.enum(PLAN_STATUSES), check: z.string().max(2_000).optional(), blocked: z.string().max(2_000).optional(),
  review: z.enum(["held", "not_held", "uncertain"]).optional() }))
  .min(1).max(MAX_PLAN_STEPS);
// `agent` is absent until the agent first starts (decision 026), `sandbox` while the session follows the operator's
// choice (decision 030), `plan` while no work is under way (decision 033), and `isolated` unless the operator chose
// an isolated workspace before the session's first request. `mode` is absent from sessions saved before modes existed,
// which run in accept edits, as they did.
const PERMISSION_MODES = ["read-only", "accept-edits", "full-access"] as const satisfies readonly PermissionMode[];
const sessionSchema: z.ZodType<{ id: string; title: string;
  engineId: string; entries: TranscriptEntry[];
  inspections: { title: string; summary: string; detail: string; diff?: string | undefined }[];
  workspace: string | null;
  interrupted: boolean; blocked: boolean; agent?: string | undefined; retiredEngineIds: string[];
  sandbox?: SandboxPreference | undefined; plan?: PlanStep[] | undefined; isolated?: true | undefined;
  mode?: PermissionMode | undefined; titleSource: TitleSource }> =
    z.strictObject({ id: z.string().min(1), title: z.string().min(1).max(100),
      engineId: z.uuid(), entries: z.array(entrySchema), inspections: z.array(inspectionSchema),
      workspace: z.string().min(1).nullable(),
      interrupted: z.boolean(), blocked: z.boolean(),
      agent: agentModelSchema.optional(), retiredEngineIds: z.array(z.uuid()).max(1_000),
      sandbox: z.enum(SANDBOX_PREFERENCES).optional(), plan: planSchema.optional(), isolated: z.literal(true).optional(),
      mode: z.enum(PERMISSION_MODES).optional(), titleSource: z.enum(["counter", "request", "generated", "operator"]) });
const measurementSchema: z.ZodType<ReviewMeasurement> = z.strictObject({ at: z.iso.datetime(),
  depth: z.enum(["standard", "deep"]), correction: z.boolean(), durationMs: z.number().nonnegative(),
  tokens: z.number().nonnegative(), models: z.strictObject({ reviewer: z.string().min(1).max(100),
    refuter: z.string().min(1).max(100), validator: z.string().min(1).max(100) }).optional() });
const reportsSchema = z.array(z.string().refine((path) => normalizeReportPath(path) === path, "not a report path"))
  .max(MAX_CHECK_REPORTS);
const checkSchema: z.ZodType<{ command: string; reports: string[]; related?: { command: string; reports: string[] } | undefined }> =
  z.strictObject({ command: z.string().min(1).max(1000), reports: reportsSchema,
    // Absent from files written before related forms existed, which stay valid.
    related: z.strictObject({ command: z.string().min(1).max(1000).refine((command) => command.includes(RELATED_FILES),
      "a related form names {files}"), reports: reportsSchema }).optional() });
// Version 8 drops the native sandbox from a session's sandbox choice (decision 047).
const snapshotVersion = 8;
/** A saved rule for commands on this computer (decision 049), only one the operator may save. */
const commandRuleSchema = z.array(z.string().min(1).max(100)).min(2).max(8).refine(canSaveRule, "not a rule that may be saved");
const snapshotSchema = z.strictObject({ format: z.literal("tesota-shell-sessions"), version: z.literal(snapshotVersion),
      source: z.string(), checks: z.array(checkSchema).max(20).nullable(),
      network: z.array(z.string().refine(isNetworkDestination)).max(200),
      // Absent from files written before rules existed, which stay valid.
      commandRules: z.array(commandRuleSchema).max(100).default([]),
      // Absent from files written before hidden files existed, which stay valid.
      checkSecrets: z.array(z.string().min(1).max(1_000)).max(50).default([]),
      // The mode last chosen in this repository, which new sessions start in; absent from files written before modes.
      mode: z.enum(PERMISSION_MODES).default("accept-edits"),
      reviews: z.array(measurementSchema).max(MEASUREMENTS_KEPT),
      sessions: z.array(sessionSchema) });
export type ShellSessionRecord = z.infer<typeof sessionSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

export interface ShellSessionStore {
  list(): readonly ShellSessionRecord[];
  create(): ShellSessionRecord;
  remove(id: string): void;
  append(id: string, entry: TranscriptEntry): void;
  inspect(id: string, inspection: { title: string; summary: string; detail: string; diff?: string | undefined }): void;
  setWorkspace(id: string, directory: string): void;
  /** Checks the operator approved for this repository, with their reports, or null before the first choice. */
  checks(): readonly ApprovedCheck[] | null;
  setChecks(checks: readonly ApprovedCheck[]): void;
  /** Files hidden from the agent that the operator let this repository's checks read, relative with forward slashes. */
  checkSecrets(): readonly string[];
  setCheckSecrets(paths: readonly string[]): void;
  /** Forget the approved checks and the hidden files they may read, so the next review asks again. */
  resetChecks(): void;
  /** Network destinations the operator allowed for every session of this repository. */
  allowedNetwork(): readonly string[];
  allowNetwork(destinations: readonly string[]): void;
  /** Rules the operator saved for this repository's commands on this computer (decision 049). */
  commandRules(): readonly CommandRule[];
  saveCommandRule(rule: CommandRule): void;
  /** The permission mode last chosen in this repository, which new sessions start in. */
  lastMode(): PermissionMode;
  /** Switch a session's permission mode; it also becomes the mode new sessions of this repository start in. */
  setMode(id: string, mode: PermissionMode): void;
  /** This repository's measured review steps, newest last, from which reviews are forecast. */
  reviewMeasurements(): readonly ReviewMeasurement[];
  recordReviewMeasurement(measurement: ReviewMeasurement): void;
  markActive(id: string, active: boolean): void;
  block(id: string): void;
  /**
   * Give the session's agent a new conversation id, keeping the previous one
   * in `retiredEngineIds` so its transcript is removed with the session.
   */
  rotateEngine(id: string): string;
  /**
   * The model this session's agent runs on, as `route:model`: recorded when
   * the agent first starts and when the operator switches it (decision 026).
   * Absent until then, when new agents use the operator's choice for the role.
   */
  setAgentModel(id: string, choice: string): void;
  /**
   * Where this session's commands run, chosen with `/sandbox` (decision 030);
   * undefined follows the operator's choice for new sessions (`tesota sandbox`).
   */
  setSandbox(id: string, preference: SandboxPreference | undefined): void;
  /** Work in an isolated workspace rather than the operator's files, chosen with `/isolate` before any work. */
  setIsolated(id: string): void;
  /** The agent's plan for the session's current work (decision 033); undefined once that work ends. */
  setPlan(id: string, plan: readonly PlanStep[] | undefined): void;
  /**
   * Name the session, when `replacesTitle` lets a name from this source
   * replace the current one (decision 036); whether it did.
   */
  setTitle(id: string, title: string, source: TitleSource): boolean;
  close(): void;
}

function readSnapshot(path: string, source: string): Snapshot {
  const empty: Snapshot = { format: "tesota-shell-sessions", version: snapshotVersion, source, checks: null,
    network: [], commandRules: [], checkSecrets: [], mode: "accept-edits", reviews: [], sessions: [] };
  if (!existsSync(path)) return empty;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  // Snapshots from earlier versions are discarded; the next save replaces the file.
  const version: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "version") : undefined;
  if (typeof version === "number" && version < snapshotVersion) return empty;
  return snapshotSchema.parse(value);
}

export const DEFAULT_SESSION_STORE_ROOT: string = join(homedir(), ".tesota", "shell-sessions");

/**
 * A repository's identity for saved sessions: its resolved path, without case
 * where the file system ignores it. The file is found and checked by the same key.
 */
function sourceKey(source: string): string {
  return pathKey(resolve(source));
}

function storePath(source: string, root: string): string {
  return join(root, createHash("sha256").update(sourceKey(source)).digest("hex") + ".json");
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
    if (sourceKey(snapshot.source) !== sourceKey(source)) throw new Error("Saved Tesota sessions belong to another repository");
    const sessions = new Map(snapshot.sessions.map((session) => [session.id,
      { ...session, entries: [...session.entries], inspections: [...session.inspections] }]));
    if (sessions.size !== snapshot.sessions.length) throw new Error("Duplicate saved Tesota session");
    let checks = snapshot.checks;
    let network = snapshot.network;
    let commandRules: readonly CommandRule[] = snapshot.commandRules;
    let checkSecrets: readonly string[] = snapshot.checkSecrets;
    let mode: PermissionMode = snapshot.mode;
    let reviews: readonly ReviewMeasurement[] = snapshot.reviews;
    let closed = false;
    const save = (): void => {
      if (closed) throw new Error("Tesota session store closed");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ format: "tesota-shell-sessions", version: snapshotVersion,
          source, checks, network, commandRules, checkSecrets, mode, reviews, sessions: [...sessions.values()] }) + "\n",
        { encoding: "utf8", mode: 0o600 });
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
          interrupted: false, blocked: false, retiredEngineIds: [], mode, titleSource: "counter" as const };
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
      setChecks: (approved) => {
        const previous = checks;
        checks = z.array(checkSchema).max(20).parse(approved.map((check) => ({ command: check.command, reports: [...check.reports],
          ...check.related === undefined ? {} : { related: { command: check.related.command, reports: [...check.related.reports] } } })));
        try { save(); } catch (error) { checks = previous; throw error; }
      },
      checkSecrets: () => checkSecrets,
      resetChecks: () => {
        const previous = { checks, checkSecrets };
        checks = null;
        checkSecrets = [];
        try { save(); } catch (error) { ({ checks, checkSecrets } = previous); throw error; }
      },
      setCheckSecrets: (paths) => {
        const previous = checkSecrets;
        checkSecrets = z.array(z.string().min(1).max(1_000)).max(50).parse([...new Set(paths)]);
        try { save(); } catch (error) { checkSecrets = previous; throw error; }
      },
      allowedNetwork: () => network,
      allowNetwork: (destinations) => {
        const previous = network;
        network = [...new Set([...network, ...destinations.map((destination) => z.string()
          .refine(isNetworkDestination).parse(destination))])];
        try { save(); } catch (error) { network = previous; throw error; }
      },
      commandRules: () => commandRules,
      saveCommandRule: (rule) => {
        const saved = commandRuleSchema.parse([...rule]);
        if (commandRules.some((existing) => existing.join("\0") === saved.join("\0"))) return;
        const previous = commandRules;
        commandRules = [...commandRules, saved];
        try { save(); } catch (error) { commandRules = previous; throw error; }
      },
      lastMode: () => mode,
      setMode: (id, chosen) => {
        const session = find(id);
        const previous = { session: session.mode, mode };
        session.mode = z.enum(PERMISSION_MODES).parse(chosen);
        mode = session.mode;
        try { save(); } catch (error) {
          if (previous.session === undefined) delete session.mode; else session.mode = previous.session;
          mode = previous.mode;
          throw error;
        }
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
        const retired = session.retiredEngineIds;
        session.engineId = randomUUID();
        session.retiredEngineIds = [...retired, previous];
        try { save(); } catch (error) {
          session.engineId = previous;
          session.retiredEngineIds = retired;
          throw error;
        }
        return session.engineId;
      },
      setAgentModel: (id, choice) => {
        const session = find(id);
        const previous = session.agent;
        session.agent = agentModelSchema.parse(choice);
        try { save(); } catch (error) {
          if (previous === undefined) delete session.agent; else session.agent = previous;
          throw error;
        }
      },
      setSandbox: (id, preference) => {
        const session = find(id);
        const previous = session.sandbox;
        if (preference === undefined) delete session.sandbox; else session.sandbox = z.enum(SANDBOX_PREFERENCES).parse(preference);
        try { save(); } catch (error) {
          if (previous === undefined) delete session.sandbox; else session.sandbox = previous;
          throw error;
        }
      },
      setIsolated: (id) => {
        const session = find(id);
        session.isolated = true;
        try { save(); } catch (error) { delete session.isolated; throw error; }
      },
      setTitle: (id, title, source) => {
        const session = find(id);
        if (!replacesTitle(session.titleSource, source)) return false;
        const previous = { title: session.title, source: session.titleSource };
        session.title = z.string().min(1).max(100).parse(title);
        session.titleSource = source;
        try { save(); } catch (error) {
          session.title = previous.title;
          session.titleSource = previous.source;
          throw error;
        }
        return true;
      },
      setPlan: (id, plan) => {
        const session = find(id);
        const previous = session.plan;
        if (plan === undefined) delete session.plan; else session.plan = planSchema.parse(plan);
        try { save(); } catch (error) {
          if (previous === undefined) delete session.plan; else session.plan = previous;
          throw error;
        }
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
