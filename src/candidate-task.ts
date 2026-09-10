import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as z from "zod";
import { inspectCandidateCheckout, readCandidateBaselineFiles } from "./candidate-checkout.js";

const taskId = "pi-decision-status";
const editedFile = "docs/decisions/002-use-pi.md";
const readFiles = Object.freeze([editedFile, "docs/roadmap.md", "experiments/codex/history.md"] as const);
export const PI_DECISION_TASK_LIMITS: Readonly<{ reads: number; edits: number; checks: number; fileBytes: number }> =
  Object.freeze({ reads: 8, edits: 2, checks: 3, fileBytes: 64 * 1024 });
const oldStatus = "Status: adopted for the current experiments. Synthetic compatibility is reported\naccepted; successful live model-turn and verification-tool integration remain open.";
export const PI_DECISION_TASK_STATUS = "Status: adopted for the current experiments. Synthetic compatibility is reported\naccepted; bounded live model-turn, verification-tool and candidate-correction\nexperiments have passed. These results do not establish a complete repository task cycle.";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.strictObject({
  format: z.literal("tesota-candidate-task"), version: z.literal(1), task: z.literal(taskId),
  baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  inputs: z.record(z.enum(readFiles), hashSchema),
});
type TaskPlan = z.infer<typeof planSchema>;
const taskReadSchema = z.strictObject({ path: z.enum(readFiles) });
const taskCheckSchema = z.strictObject({});
const taskEditSchema = z.strictObject({ path: z.literal(editedFile), expectedSha256: hashSchema,
  content: z.string().max(PI_DECISION_TASK_LIMITS.fileBytes).refine((text) =>
    Buffer.byteLength(text) <= PI_DECISION_TASK_LIMITS.fileBytes && !text.includes("\0") && Buffer.from(text).toString("utf8") === text) });

export function taskRequestSchemas(): { read: z.ZodType; replace: z.ZodType; check: z.ZodType } {
  return { read: taskReadSchema, replace: taskEditSchema, check: taskCheckSchema };
}

export interface CandidateTaskCheck {
  readonly task: typeof taskId;
  readonly status: "passed" | "check_failed";
  readonly provenance: "issued" | "recorded_untrusted";
  readonly baseline: string;
  readonly sourceSha256: string;
  readonly taskAcceptance: "not_evaluated";
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

async function readText(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > PI_DECISION_TASK_LIMITS.fileBytes ||
      relative(path, await realpath(path)) !== "") throw new Error("Task file unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(PI_DECISION_TASK_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > PI_DECISION_TASK_LIMITS.fileBytes) throw new Error("Task file exceeds bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

async function observe(directory: string, plan: TaskPlan): Promise<{ checkout: string; content: string }> {
  const inspection = await inspectCandidateCheckout(directory);
  if (inspection.baseline !== plan.baseline || inspection.headChanged ||
      inspection.changes.some((change) => change.path !== editedFile || change.status !== "M")) throw new Error("Task scope changed");
  let content = "";
  for (const path of readFiles) {
    const text = await readText(join(inspection.checkout, path));
    if (path === editedFile) content = text;
    else if (hash(text) !== plan.inputs[path]) throw new Error("Task context changed");
  }
  return { checkout: inspection.checkout, content };
}

function expectedContent(files: Readonly<Record<string, string>>, plan: TaskPlan): string {
  let expected = "";
  for (const path of readFiles) {
    const baseline = files[path];
    if (baseline === undefined || hash(baseline) !== plan.inputs[path]) throw new Error("Task baseline changed");
    if (path === editedFile) {
      if (baseline.split(oldStatus).length !== 2) throw new Error("Task is not applicable to this baseline");
      expected = baseline.replace(oldStatus, PI_DECISION_TASK_STATUS);
    }
  }
  return expected;
}

/** Authority is this in-memory, application-selected task, never a loaded JSON plan. */
export class PiDecisionTask {
  readonly #directory: string;
  readonly #plan: TaskPlan;
  readonly #expected: string;
  #current: string;
  #reads = 0;
  #edits = 0;
  #checks = 0;
  #closed = false;
  #busy = false;

  private constructor(directory: string, plan: TaskPlan, initial: string, expected: string) {
    this.#directory = directory; this.#plan = plan; this.#current = initial; this.#expected = expected;
  }

  static async prepare(directory: string): Promise<PiDecisionTask> {
    const inspection = await inspectCandidateCheckout(directory);
    if (inspection.headChanged || inspection.changes.length !== 0) throw new Error("Task requires an unchanged candidate");
    const snapshot = await readCandidateBaselineFiles(directory, readFiles);
    if (snapshot.baseline !== inspection.baseline) throw new Error("Task baseline changed");
    const inputs: Record<string, string> = {};
    for (const path of readFiles) {
      const content = snapshot.files[path];
      if (content === undefined) throw new Error("Missing task input");
      inputs[path] = hash(content);
    }
    const plan = planSchema.parse({ format: "tesota-candidate-task", version: 1, task: taskId, baseline: inspection.baseline, inputs });
    const initial = await observe(directory, plan);
    if (hash(initial.content) !== plan.inputs[editedFile]) throw new Error("Task initial source changed");
    const expected = expectedContent(snapshot.files, plan);
    const file = await open(join(inspection.directory, "task.json"), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
    return new PiDecisionTask(inspection.directory, plan, initial.content, expected);
  }

  describe(): {
    task: string; baseline: string; objective: string; readFiles: readonly string[];
    writeFiles: readonly string[]; requiredStatus: string; limits: typeof PI_DECISION_TASK_LIMITS;
  } {
    return { task: taskId, baseline: this.#plan.baseline,
      objective: "Correct the outdated Pi integration status. Replace only its status paragraph, preserving every other byte.",
      readFiles, writeFiles: [editedFile], requiredStatus: PI_DECISION_TASK_STATUS, limits: PI_DECISION_TASK_LIMITS };
  }

  close(): void { this.#closed = true; }

  async #operation<T>(action: (snapshot: { checkout: string; content: string }) => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy) { this.#closed = true; throw new Error("Task is closed or busy"); }
    this.#busy = true;
    try {
      const snapshot = await observe(this.#directory, this.#plan);
      if (this.#closed || snapshot.content !== this.#current) throw new Error("Task source changed externally");
      const result = await action(snapshot);
      if (this.#closed) throw new Error("Task closed");
      return result;
    } catch { this.#closed = true; throw new Error("Task operation denied or unavailable"); }
    finally { this.#busy = false; }
  }

  async read(request: unknown): Promise<{ content: string; sha256: string }> {
    return this.#operation(async ({ checkout }) => {
      const args = taskReadSchema.parse(request);
      if (this.#reads >= PI_DECISION_TASK_LIMITS.reads) throw new Error("Read budget exceeded");
      this.#reads += 1;
      const content = await readText(join(checkout, args.path));
      return { content, sha256: hash(content) };
    });
  }

  async replace(request: unknown): Promise<void> {
    return this.#operation(async ({ checkout, content }) => {
      const args = taskEditSchema.parse(request);
      if (this.#checks === 0 || this.#edits >= PI_DECISION_TASK_LIMITS.edits || args.expectedSha256 !== hash(content)) throw new Error("Edit denied");
      const target = join(checkout, editedFile);
      const temporary = join(this.#directory, ".tesota-" + randomUUID() + ".tmp");
      const file = await open(temporary, "wx", 0o600);
      try {
        try { await file.writeFile(args.content, "utf8"); await file.sync(); } finally { await file.close(); }
      } catch { await unlink(temporary).catch(() => {}); throw new Error("Write failed"); }
      try {
        const current = await observe(this.#directory, this.#plan);
        if (this.#closed || current.content !== content || relative(dirname(target), await realpath(dirname(target))) !== "") throw new Error("Task changed during edit");
        await rename(temporary, target);
        this.#current = args.content; this.#edits += 1;
        await observe(this.#directory, this.#plan);
      } finally { await unlink(temporary).catch(() => {}); }
    });
  }

  async check(): Promise<CandidateTaskCheck> {
    return this.#operation(async ({ content }) => {
      if (this.#checks >= PI_DECISION_TASK_LIMITS.checks) throw new Error("Check budget exceeded");
      this.#checks += 1;
      return { task: taskId, status: content === this.#expected ? "passed" : "check_failed", provenance: "issued",
        baseline: this.#plan.baseline, sourceSha256: hash(content), taskAcceptance: "not_evaluated" };
    });
  }
}

/** Read-only rechecking of a stored plan does not reopen its editing authority. */
export async function checkCandidateTask(directory: string): Promise<CandidateTaskCheck> {
  const parsed = planSchema.safeParse(JSON.parse(await readText(join(directory, "task.json"))));
  if (!parsed.success) throw new Error("Task plan invalid");
  const baseline = await readCandidateBaselineFiles(directory, readFiles);
  if (baseline.baseline !== parsed.data.baseline) throw new Error("Task baseline changed");
  const expected = expectedContent(baseline.files, parsed.data);
  const snapshot = await observe(directory, parsed.data);
  return { task: taskId, status: snapshot.content === expected ? "passed" : "check_failed", provenance: "recorded_untrusted",
    baseline: parsed.data.baseline, sourceSha256: hash(snapshot.content), taskAcceptance: "not_evaluated" };
}
