import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as z from "zod";
import { inspectCandidateCheckout, readCandidateBaselineFiles } from "./candidate-checkout.js";
import {
  CANDIDATE_TASK_IDS,
  CANDIDATE_TASK_LIMITS,
  DEFAULT_CANDIDATE_TASK_ID,
  candidateTaskContract,
  candidateTaskDefinition,
  candidateTaskDefinitionSha256,
  taskRequestSchemas,
  type CandidateTaskDefinition,
  type CandidateTaskId,
} from "./candidate-task-definition.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const contractSchema = z.strictObject({
  objective: z.string().min(1),
  oracle: z.string().min(1),
  oracleSha256: hashSchema,
  readFiles: z.array(z.string()).min(1),
  writeFiles: z.array(z.string()).min(1).max(CANDIDATE_TASK_LIMITS.edits),
  requiredStatus: z.string(),
  limits: z.strictObject({
    reads: z.literal(CANDIDATE_TASK_LIMITS.reads),
    edits: z.literal(CANDIDATE_TASK_LIMITS.edits),
    checks: z.literal(CANDIDATE_TASK_LIMITS.checks),
    fileBytes: z.literal(CANDIDATE_TASK_LIMITS.fileBytes),
  }),
  effects: z.tuple([
    z.literal("read_candidate"),
    z.literal("replace_candidate_file"),
    z.literal("run_task_check"),
  ]),
  promotion: z.enum(["allowed", "denied"]),
});
const planSchema = z.strictObject({
  format: z.literal("tesota-candidate-task"),
  version: z.literal(3),
  task: z.enum(CANDIDATE_TASK_IDS),
  definitionSha256: hashSchema,
  contract: contractSchema,
  baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  inputs: z.record(z.string(), hashSchema),
}).refine((plan) => {
  const definition = candidateTaskDefinition(plan.task);
  return plan.definitionSha256 === candidateTaskDefinitionSha256(plan.task) &&
    JSON.stringify(plan.contract) === JSON.stringify(candidateTaskContract(plan.task)) &&
    Object.keys(plan.inputs).length === definition.readFiles.length &&
    definition.readFiles.every((path) => plan.inputs[path] !== undefined);
});
type TaskPlan = z.infer<typeof planSchema>;

export interface CandidateTaskCheck {
  readonly task: CandidateTaskId;
  readonly status: "passed" | "check_failed";
  readonly provenance: "issued" | "recorded_untrusted";
  readonly baseline: string;
  readonly writeSetSha256: string;
  readonly taskAcceptance: "not_evaluated";
  readonly diagnostics?: readonly string[];
  readonly verifierSha256?: string;
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

async function readText(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > CANDIDATE_TASK_LIMITS.fileBytes ||
      relative(path, await realpath(path)) !== "") throw new Error("Task file unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(CANDIDATE_TASK_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > CANDIDATE_TASK_LIMITS.fileBytes) throw new Error("Task file exceeds bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

type TaskFiles = Readonly<Record<string, string>>;

function sameFiles(left: TaskFiles, right: TaskFiles): boolean {
  const paths = Object.keys(left);
  return paths.length === Object.keys(right).length && paths.every((path) => left[path] === right[path]);
}

export function taskWriteSetSha256(files: TaskFiles, paths: readonly string[]): string {
  return hash(JSON.stringify(paths.map((path) => {
    const content = files[path];
    if (content === undefined) throw new Error("Task write set unavailable");
    return [path, hash(content)];
  })));
}

async function observe(directory: string, plan: TaskPlan): Promise<{ checkout: string; files: TaskFiles }> {
  const definition = candidateTaskDefinition(plan.task);
  const writable = new Set(definition.writeFiles);
  const inspection = await inspectCandidateCheckout(directory);
  if (inspection.baseline !== plan.baseline || inspection.headChanged ||
      inspection.changes.some((change) => !writable.has(change.path) || change.status !== "M")) throw new Error("Task scope changed");
  const files: Record<string, string> = {};
  for (const path of definition.readFiles) {
    const text = await readText(join(inspection.checkout, path));
    files[path] = text;
    if (!writable.has(path) && hash(text) !== plan.inputs[path]) throw new Error("Task context changed");
  }
  return { checkout: inspection.checkout, files };
}

function expectedContent(files: TaskFiles, plan: TaskPlan): TaskFiles {
  const definition = candidateTaskDefinition(plan.task);
  for (const path of definition.readFiles) {
    const baseline = files[path];
    if (baseline === undefined || hash(baseline) !== plan.inputs[path]) throw new Error("Task baseline changed");
  }
  return definition.expected(files);
}

/** Authority is this in-memory, application-selected task, never a loaded JSON plan. */
export class CandidateTask {
  readonly #directory: string;
  readonly #plan: TaskPlan;
  readonly #expected: TaskFiles;
  #current: TaskFiles;
  #reads = 0;
  #edits = 0;
  #checks = 0;
  #closed = false;
  #busy = false;

  private constructor(directory: string, plan: TaskPlan, initial: TaskFiles, expected: TaskFiles) {
    this.#directory = directory; this.#plan = plan; this.#current = initial; this.#expected = expected;
  }

  static async prepare(directory: string, id: CandidateTaskId = DEFAULT_CANDIDATE_TASK_ID): Promise<CandidateTask> {
    const definition = candidateTaskDefinition(id);
    const inspection = await inspectCandidateCheckout(directory);
    if (inspection.headChanged || inspection.changes.length !== 0) throw new Error("Task requires an unchanged candidate");
    const snapshot = await readCandidateBaselineFiles(directory, definition.readFiles);
    if (snapshot.baseline !== inspection.baseline) throw new Error("Task baseline changed");
    const inputs: Record<string, string> = {};
    for (const path of definition.readFiles) {
      const content = snapshot.files[path];
      if (content === undefined) throw new Error("Missing task input");
      inputs[path] = hash(content);
    }
    const plan = planSchema.parse({
      format: "tesota-candidate-task",
      version: 3,
      task: id,
      definitionSha256: candidateTaskDefinitionSha256(id),
      contract: candidateTaskContract(id),
      baseline: inspection.baseline,
      inputs,
    });
    if (definition.seed !== undefined) {
      const seeded = definition.seed(snapshot.files);
      for (const path of definition.writeFiles) {
        const content = seeded[path];
        if (content === undefined) throw new Error("Task seed unavailable");
        await writeFile(join(inspection.checkout, path), content, "utf8");
      }
    }
    const initial = await observe(directory, plan);
    const unchanged = definition.writeFiles.every((path) => hash(initial.files[path] ?? "") === plan.inputs[path]);
    if (definition.seed === undefined && !unchanged) {
      throw new Error("Task initial source changed");
    }
    if (definition.seed !== undefined && unchanged) {
      throw new Error("Task was not seeded");
    }
    const expected = expectedContent(snapshot.files, plan);
    const file = await open(join(inspection.directory, "task.json"), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
    return new CandidateTask(inspection.directory, plan, initial.files, expected);
  }

  describe(): {
    task: CandidateTaskId;
    baseline: string;
    definitionSha256: string;
    objective: string;
    oracle: string;
    oracleSha256: string;
    instructions: string;
    readFiles: readonly string[];
    writeFiles: readonly string[];
    requiredStatus: string;
    limits: typeof CANDIDATE_TASK_LIMITS;
  } {
    const definition = candidateTaskDefinition(this.#plan.task);
    return {
      task: this.#plan.task,
      baseline: this.#plan.baseline,
      definitionSha256: this.#plan.definitionSha256,
      objective: definition.objective,
      oracle: definition.oracle,
      oracleSha256: this.#plan.contract.oracleSha256,
      instructions: definition.instructions,
      readFiles: definition.readFiles,
      writeFiles: definition.writeFiles,
      requiredStatus: definition.requiredStatus,
      limits: CANDIDATE_TASK_LIMITS,
    };
  }

  close(): void { this.#closed = true; }

  async #operation<T>(action: (snapshot: { checkout: string; files: TaskFiles }) => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy) { this.#closed = true; throw new Error("Task is closed or busy"); }
    this.#busy = true;
    try {
      const snapshot = await observe(this.#directory, this.#plan);
      if (this.#closed || !sameFiles(snapshot.files, this.#current)) throw new Error("Task source changed externally");
      const result = await action(snapshot);
      if (this.#closed) throw new Error("Task closed");
      return result;
    } catch { this.#closed = true; throw new Error("Task operation denied or unavailable"); }
    finally { this.#busy = false; }
  }

  async read(request: unknown): Promise<{ content: string; sha256: string }> {
    return this.#operation(async ({ checkout }) => {
      const args = taskRequestSchemas(this.#plan.task).read.parse(request);
      if (this.#reads >= CANDIDATE_TASK_LIMITS.reads) throw new Error("Read budget exceeded");
      this.#reads += 1;
      const content = await readText(join(checkout, args.path));
      return { content, sha256: hash(content) };
    });
  }

  async replace(request: unknown): Promise<void> {
    return this.#operation(async ({ checkout, files }) => {
      const args = taskRequestSchemas(this.#plan.task).replace.parse(request);
      const currentContent = files[args.path];
      if (currentContent === undefined || this.#checks === 0 || this.#edits >= CANDIDATE_TASK_LIMITS.edits ||
          args.expectedSha256 !== hash(currentContent)) throw new Error("Edit denied");
      const target = join(checkout, args.path);
      const temporary = join(this.#directory, ".tesota-" + randomUUID() + ".tmp");
      const file = await open(temporary, "wx", 0o600);
      try {
        try { await file.writeFile(args.content, "utf8"); await file.sync(); } finally { await file.close(); }
      } catch { await unlink(temporary).catch(() => {}); throw new Error("Write failed"); }
      try {
        const current = await observe(this.#directory, this.#plan);
        if (this.#closed || !sameFiles(current.files, files) || relative(dirname(target), await realpath(dirname(target))) !== "") throw new Error("Task changed during edit");
        await rename(temporary, target);
        this.#current = { ...files, [args.path]: args.content }; this.#edits += 1;
        const updated = await observe(this.#directory, this.#plan);
        if (!sameFiles(updated.files, this.#current)) throw new Error("Task write mismatch");
      } finally { await unlink(temporary).catch(() => {}); }
    });
  }

  async check(): Promise<CandidateTaskCheck> {
    return this.#operation(async ({ files }) => {
      if (this.#checks >= CANDIDATE_TASK_LIMITS.checks) throw new Error("Check budget exceeded");
      this.#checks += 1;
      const definition = candidateTaskDefinition(this.#plan.task);
      const check = definition.check(files, this.#expected);
      return { ...check, task: this.#plan.task, status: check.status, provenance: "issued",
        baseline: this.#plan.baseline, writeSetSha256: taskWriteSetSha256(files, definition.writeFiles), taskAcceptance: "not_evaluated" };
    });
  }
}

/** Read-only rechecking of a stored plan does not reopen its editing authority. */
async function loadCandidateTask(directory: string): Promise<{
  plan: TaskPlan;
  definition: CandidateTaskDefinition;
  expected: TaskFiles;
  files: TaskFiles;
}> {
  const parsed = planSchema.safeParse(JSON.parse(await readText(join(directory, "task.json"))));
  if (!parsed.success) throw new Error("Task plan invalid");
  const definition = candidateTaskDefinition(parsed.data.task);
  const baseline = await readCandidateBaselineFiles(directory, definition.readFiles);
  if (baseline.baseline !== parsed.data.baseline) throw new Error("Task baseline changed");
  const expected = expectedContent(baseline.files, parsed.data);
  const snapshot = await observe(directory, parsed.data);
  return { plan: parsed.data, definition, expected, files: snapshot.files };
}

/** Validate persisted task identity and current scope without running its oracle or granting authority. */
export async function inspectCandidateTask(directory: string): Promise<{
  task: CandidateTaskId;
  baseline: string;
  writeSetSha256: string;
}> {
  const loaded = await loadCandidateTask(directory);
  return { task: loaded.plan.task, baseline: loaded.plan.baseline,
    writeSetSha256: taskWriteSetSha256(loaded.files, loaded.definition.writeFiles) };
}

export async function checkCandidateTask(directory: string): Promise<CandidateTaskCheck> {
  const loaded = await loadCandidateTask(directory);
  const check = loaded.definition.check(loaded.files, loaded.expected);
  return { ...check, task: loaded.plan.task, status: check.status, provenance: "recorded_untrusted",
    baseline: loaded.plan.baseline, writeSetSha256: taskWriteSetSha256(loaded.files, loaded.definition.writeFiles),
    taskAcceptance: "not_evaluated" };
}
