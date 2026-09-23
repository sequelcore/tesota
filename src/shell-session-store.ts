import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as z from "zod";

const entrySchema: z.ZodType<{ role: "user" | "tesota"; text: string }> =
  z.strictObject({ role: z.enum(["user", "tesota"]), text: z.string().max(2_000_000) });
const inspectionSchema: z.ZodType<{ title: string; summary: string; detail: string }> =
  z.strictObject({ title: z.string().max(100), summary: z.string().max(10_000),
    detail: z.string().max(2_000_000) });
const budgetSchema: z.ZodType<{ turns: number; modelInvocations: number; toolCalls: number }> =
  z.strictObject({ turns: z.number().int().nonnegative().max(12),
    modelInvocations: z.number().int().nonnegative().max(36),
    toolCalls: z.number().int().nonnegative().max(96) });
const sessionSchema: z.ZodType<{ id: string; title: string;
  engineId: string; entries: { role: "user" | "tesota"; text: string }[];
  inspections: { title: string; summary: string; detail: string }[];
  proposalIds: string[]; budget: z.infer<typeof budgetSchema>;
  interrupted: boolean; blocked: boolean }> =
    z.strictObject({ id: z.string().min(1), title: z.string().min(1).max(100),
      engineId: z.uuid(), entries: z.array(entrySchema), inspections: z.array(inspectionSchema),
      proposalIds: z.array(z.uuid()), budget: budgetSchema,
      interrupted: z.boolean(), blocked: z.boolean() });
const snapshotSchema: z.ZodType<{ format: "tesota-shell-sessions"; version: 1; source: string;
  sessions: z.infer<typeof sessionSchema>[] }> =
    z.strictObject({ format: z.literal("tesota-shell-sessions"), version: z.literal(1),
      source: z.string(), sessions: z.array(sessionSchema) });
export type ShellSessionRecord = z.infer<typeof sessionSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

export interface ShellSessionStore {
  list(): readonly ShellSessionRecord[];
  create(): ShellSessionRecord;
  append(id: string, role: "user" | "tesota", text: string): void;
  inspect(id: string, inspection: { title: string; summary: string; detail: string }): void;
  linkProposal(id: string, proposalId: string): void;
  markActive(id: string, active: boolean): void;
  block(id: string): void;
  rotateEngine(id: string): string;
  recordBudget(id: string, budget: z.infer<typeof budgetSchema>): void;
  close(): void;
}

/** The store records the human transcript, never a task grant or check result. */
export function openShellSessionStore(sourceDirectory: string,
  root: string = join(homedir(), ".tesota", "shell-sessions")): ShellSessionStore {
  const source = resolve(sourceDirectory);
  const path = join(root, createHash("sha256").update(source.toLocaleLowerCase("en-US")).digest("hex") + ".json");
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch {
    const owner = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("Tesota shell lock cannot be read safely");
    let alive = true;
    try { process.kill(owner, 0); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false; }
    if (alive) throw new Error("This repository already has an open Tesota shell. Close it before opening another.");
    unlinkSync(lockPath);
    lock = openSync(lockPath, "wx", 0o600);
  }
  try {
    writeFileSync(lock, String(process.pid));
    const snapshot: Snapshot = existsSync(path) ? snapshotSchema.parse(JSON.parse(readFileSync(path, "utf8"))) :
      { format: "tesota-shell-sessions", version: 1, source, sessions: [] };
    if (snapshot.source !== source) throw new Error("Saved Tesota sessions belong to another repository");
    const sessions = new Map(snapshot.sessions.map((session) => [session.id,
      { ...session, entries: [...session.entries], inspections: [...session.inspections] }]));
    if (sessions.size !== snapshot.sessions.length) throw new Error("Duplicate saved Tesota session");
    let closed = false;
    const save = (): void => {
      if (closed) throw new Error("Tesota session store closed");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ format: "tesota-shell-sessions", version: 1,
          source, sessions: [...sessions.values()] }) + "\n", { encoding: "utf8", mode: 0o600 });
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
        const session = { id: randomUUID(), title: `Session ${sessions.size + 1}`,
          engineId: randomUUID(), entries: [], inspections: [], proposalIds: [],
          budget: { turns: 0, modelInvocations: 0, toolCalls: 0 }, interrupted: false, blocked: false };
        sessions.set(session.id, session);
        try { save(); } catch (error) { sessions.delete(session.id); throw error; }
        return session;
      },
      append: (id, role, text) => {
        const session = find(id);
        session.entries.push(entrySchema.parse({ role, text }));
        try { save(); } catch (error) { session.entries.pop(); throw error; }
      },
      inspect: (id, inspection) => {
        const session = find(id);
        session.inspections.push(inspectionSchema.parse(inspection));
        try { save(); } catch (error) { session.inspections.pop(); throw error; }
      },
      linkProposal: (id, proposalId) => {
        const session = find(id);
        const parsed = z.uuid().parse(proposalId);
        if (session.proposalIds.includes(parsed)) return;
        session.proposalIds.push(parsed);
        try { save(); } catch (error) { session.proposalIds.pop(); throw error; }
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
      recordBudget: (id, input) => {
        const session = find(id);
        const budget = budgetSchema.parse(input);
        if (budget.turns < session.budget.turns ||
            budget.modelInvocations < session.budget.modelInvocations ||
            budget.toolCalls < session.budget.toolCalls) throw new Error("Tesota budget cannot move backwards");
        const previous = session.budget;
        session.budget = budget;
        try { save(); } catch (error) { session.budget = previous; throw error; }
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
