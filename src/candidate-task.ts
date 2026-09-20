import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as z from "zod";
import { inspectCandidateCheckout, readCandidateBaselineFiles } from "./candidate-checkout.js";
import { validateProposalRunGrant, type ProposalRunGrant } from "./proposal-admission.js";
import { checkRepositoryTypecheck, type RepositoryTypecheckResult } from "./repository-typecheck.js";
import { TASK_CHECKS, TASK_KIND, TASK_LIMITS, taskRequestSchemas, type TaskOracleResult } from "./task-contract.js";
import { captureTaskSourceInputs, matchesTaskBaseline, taskSourceInputsSchema, validateTaskSourceInputs,
  type TaskSourceInputs } from "./task-source.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const baselineSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const contractSchema = z.strictObject({
  objective: z.string().min(1), completionConditions: z.array(z.string().min(1)).min(1).max(8),
  readFiles: z.array(z.string()).min(1).max(TASK_LIMITS.reads),
  writeFiles: z.array(z.string()).min(1).max(TASK_LIMITS.edits),
  checks: z.tuple([z.literal(TASK_CHECKS[0]), z.literal(TASK_CHECKS[1])]),
  outcome: z.literal("human_review_required"),
  limits: z.strictObject({ reads: z.literal(TASK_LIMITS.reads), edits: z.literal(TASK_LIMITS.edits),
    checks: z.literal(TASK_LIMITS.checks), fileBytes: z.literal(TASK_LIMITS.fileBytes) }),
  effects: z.tuple([z.literal("read_candidate"), z.literal("replace_candidate_file"), z.literal("run_task_check")]),
  promotion: z.literal("allowed"),
});
const planShape = {
  format: z.literal("tesota-candidate-task"), task: z.literal(TASK_KIND),
  definitionSha256: hashSchema, contract: contractSchema, baseline: baselineSchema,
  inputs: z.record(z.string(), hashSchema), grant: z.unknown(),
};
const planSchema = z.discriminatedUnion("version", [
  z.strictObject({ ...planShape, version: z.literal(1) }),
  z.strictObject({ ...planShape, version: z.literal(2), sourceInputs: taskSourceInputsSchema }),
]);
type TaskPlan = z.infer<typeof planSchema>;
type TaskFiles = Readonly<Record<string, string>>;

export interface CandidateTaskCheck extends TaskOracleResult {
  readonly task: typeof TASK_KIND;
  /** The automatic-check outcome is separate from whether its process effects settled. */
  readonly outcome: "passed" | "check_failed" | "operational_failed";
  readonly settlement: "observed" | "unconfirmed";
  readonly provenance: "issued" | "recorded_untrusted";
  readonly baseline: string;
  readonly writeSetSha256: string;
  readonly sourceInputsSha256: string | null;
  readonly typecheck: RepositoryTypecheckResult | null;
  readonly taskAcceptance: "not_evaluated";
}

export interface CandidateTaskDescription {
  readonly task: typeof TASK_KIND;
  readonly baseline: string;
  readonly definitionSha256: string;
  readonly objective: string;
  readonly completionConditions: readonly string[];
  readonly instructions: string;
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly string[];
  readonly checks: typeof TASK_CHECKS;
  readonly outcome: "human_review_required";
  readonly limits: typeof TASK_LIMITS;
  readonly executionCause?: "initial_implementation" | "semantic_revision";
  readonly semanticRevision?: Readonly<{
    refinement: string;
    parentReviewSha256: string;
    parentWriteSetSha256: string;
    parentCheckSha256: string;
    effectiveCriteriaSha256: string;
    parentEvidence: CandidateTaskCheck;
    remainingBudget: Readonly<{
      reads: number; edits: number; checks: number; modelInvocations: number; toolCalls: number; activeMs: number;
    }>;
  }>;
}

export interface CandidateTaskUsage {
  readonly reads: number;
  readonly edits: number;
  readonly checks: number;
}

export interface CandidateTaskExecution {
  describe(): CandidateTaskDescription;
  requestSchemas(): ReturnType<typeof taskRequestSchemas>;
  read(request: unknown): Promise<{ content: string; sha256: string }>;
  replace(request: unknown): Promise<void>;
  check(signal?: AbortSignal): Promise<CandidateTaskCheck>;
  usage(): CandidateTaskUsage;
  close(freeze?: boolean): void;
}

export interface SemanticExecutionContext {
  readonly cause: "semantic_revision";
  readonly refinement: string;
  readonly parentReviewSha256: string;
  readonly parentWriteSetSha256: string;
  readonly parentCheckSha256: string;
  readonly effectiveCriteriaSha256: string;
  readonly parentEvidence: CandidateTaskCheck;
  readonly remainingBudget: Readonly<{
    reads: number; edits: number; checks: number; modelInvocations: number; toolCalls: number; activeMs: number;
  }>;
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function contractFor(grant: ProposalRunGrant): z.infer<typeof contractSchema> {
  return { objective: grant.objective, completionConditions: [...grant.completionConditions],
    readFiles: [...grant.readFiles], writeFiles: [...grant.writeFiles], checks: [...TASK_CHECKS],
    outcome: "human_review_required", limits: TASK_LIMITS,
    effects: ["read_candidate", "replace_candidate_file", "run_task_check"], promotion: "allowed" };
}

function instructionsFor(grant: ProposalRunGrant): string {
  return `Complete the approved TypeScript outcome: ${grant.objective}\nCompletion conditions:\n` +
    grant.completionConditions.map((condition) => `- ${condition}`).join("\n") +
    "\nChange only the admitted files. The automatic checks establish scope integrity and TypeScript compilation, not outcome correctness.";
}

function definitionSha256(grant: ProposalRunGrant, contract: z.infer<typeof contractSchema>,
  binding?: Pick<Extract<TaskPlan, { version: 2 }>, "inputs" | "sourceInputs">): string {
  if (binding !== undefined) {
    return hash(JSON.stringify({ task: TASK_KIND, version: 2, grant, contract,
      instructions: instructionsFor(grant), inputs: binding.inputs, sourceInputs: binding.sourceInputs }));
  }
  return hash(JSON.stringify({ task: TASK_KIND, version: 1, grant, contract, instructions: instructionsFor(grant) }));
}

function sourceInputsSha256(plan: TaskPlan): string | null {
  return plan.version === 2 ? hash(JSON.stringify(plan.sourceInputs)) : null;
}

async function readText(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > TASK_LIMITS.fileBytes ||
      relative(path, await realpath(path)) !== "") throw new Error("Task file unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(TASK_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > TASK_LIMITS.fileBytes) throw new Error("Task file exceeds bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

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

function validatePlan(value: unknown): { plan: TaskPlan; grant: ProposalRunGrant } {
  const plan = planSchema.parse(value);
  const grant = validateProposalRunGrant(plan.grant);
  const contract = contractFor(grant);
  if (grant.baseline !== plan.baseline || plan.definitionSha256 !== definitionSha256(grant, contract,
    plan.version === 2 ? plan : undefined) ||
      JSON.stringify(plan.contract) !== JSON.stringify(contract) ||
      Object.keys(plan.inputs).length !== grant.readFiles.length ||
      !grant.readFiles.every((path) => plan.inputs[path] !== undefined)) throw new Error("Task plan invalid");
  return { plan, grant };
}

async function observe(directory: string, plan: TaskPlan, grant: ProposalRunGrant): Promise<{ checkout: string; files: TaskFiles }> {
  const writable = new Set(grant.writeFiles);
  const inspection = await inspectCandidateCheckout(directory);
  if (inspection.baseline !== plan.baseline || inspection.headChanged ||
      inspection.changes.some((change) => !writable.has(change.path) || change.status !== "M")) {
    throw new Error("Task scope changed");
  }
  const files: Record<string, string> = {};
  for (const path of grant.readFiles) {
    const content = await readText(join(inspection.checkout, path));
    files[path] = content;
    if (!writable.has(path) && hash(content) !== plan.inputs[path]) throw new Error("Task context changed");
  }
  return { checkout: inspection.checkout, files };
}

function checkScope(files: TaskFiles, plan: TaskPlan, grant: ProposalRunGrant): TaskOracleResult {
  const changed = grant.writeFiles.filter((path) => hash(files[path] ?? "") !== plan.inputs[path]);
  if (changed.length === 0) return { status: "check_failed", diagnostics: ["No admitted file changed."] };
  const suppressed = changed.filter((path) => /(?:\/\/|\/\*)\s*@ts-(?:ignore|nocheck|expect-error)\b/u.test(files[path] ?? ""));
  return suppressed.length > 0
    ? { status: "check_failed", diagnostics: [
      `TypeScript suppression directives are not admitted in ${suppressed.join(", ")}.`,
    ] }
    : { status: "passed", diagnostics: [`Scope integrity passed for ${changed.join(", ")}.`] };
}

async function checkTask(directory: string, files: TaskFiles, plan: TaskPlan,
  grant: ProposalRunGrant, signal?: AbortSignal):
Promise<{ readonly oracle: TaskOracleResult; readonly outcome: CandidateTaskCheck["outcome"];
  readonly settlement: CandidateTaskCheck["settlement"]; readonly typecheck: RepositoryTypecheckResult | null }> {
  if (signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
  const scope = checkScope(files, plan, grant);
  if (scope.status === "check_failed") {
    return { oracle: scope, outcome: "check_failed", settlement: "observed", typecheck: null };
  }
  const typecheck = await checkRepositoryTypecheck({ candidate: directory, source: grant.source }, signal);
  const settlement = typecheck.process === "unconfirmed" || typecheck.container === "unconfirmed" ? "unconfirmed" : "observed";
  if (settlement === "unconfirmed") {
    return { oracle: { status: "check_failed", diagnostics: [
      "TypeScript no-emit settlement is unconfirmed.",
    ] }, outcome: "operational_failed", settlement, typecheck };
  }
  if (typecheck.status === "passed") {
    return { oracle: { status: "passed", diagnostics: [...scope.diagnostics,
      "TypeScript no-emit check passed. Outcome correctness requires human review."] },
    outcome: "passed", settlement, typecheck };
  }
  if (typecheck.status === "check_failed") {
    return { oracle: { status: "check_failed", diagnostics: [...typecheck.diagnostics] },
      outcome: "check_failed", settlement, typecheck };
  }
  return { oracle: { status: "check_failed", diagnostics: [
    `TypeScript no-emit did not complete: ${typecheck.status}.`,
  ] }, outcome: "operational_failed", settlement, typecheck };
}

/** An execution handle derived from one immutable, operator-approved grant. */
export class CandidateTask {
  readonly #directory: string;
  readonly #plan: TaskPlan;
  readonly #grant: ProposalRunGrant;
  #current: TaskFiles;
  #reads = 0;
  #edits = 0;
  #checks = 0;
  #closed = false;
  #busy = false;
  #generation = 0;
  #activeGeneration: number | null = null;

  private constructor(directory: string, plan: TaskPlan, grant: ProposalRunGrant, initial: TaskFiles) {
    this.#directory = directory; this.#plan = plan; this.#grant = grant; this.#current = initial;
  }

  static async prepare(directory: string, grantValue: ProposalRunGrant): Promise<CandidateTask> {
    const grant = validateProposalRunGrant(grantValue);
    const inspection = await inspectCandidateCheckout(directory);
    if (inspection.headChanged || inspection.changes.length !== 0 || inspection.baseline !== grant.baseline) {
      throw new Error("Task requires the approved unchanged baseline");
    }
    const snapshot = await readCandidateBaselineFiles(directory, grant.readFiles);
    const initial: Record<string, string> = {};
    const inputs: Record<string, string> = {};
    for (const path of grant.readFiles) {
      const baseline = snapshot.files[path];
      const content = await readText(join(inspection.checkout, path));
      if (baseline === undefined || !matchesTaskBaseline(hash(content), baseline)) throw new Error("Task input differs from baseline");
      initial[path] = content;
      inputs[path] = hash(content);
    }
    const contract = contractFor(grant);
    const sourceInputs = await captureTaskSourceInputs(directory, grant.source, grant.writeFiles, snapshot.files);
    const plan = planSchema.parse({ format: "tesota-candidate-task", version: 2, task: TASK_KIND,
      definitionSha256: definitionSha256(grant, contract, { inputs, sourceInputs }), contract, baseline: grant.baseline,
      inputs, sourceInputs, grant });
    const file = await open(join(inspection.directory, "task.json"), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n", "utf8"); await file.sync(); }
    finally { await file.close(); }
    return new CandidateTask(inspection.directory, plan, grant, initial);
  }

  describe(): CandidateTaskDescription {
    return { task: TASK_KIND, baseline: this.#plan.baseline, definitionSha256: this.#plan.definitionSha256,
      objective: this.#grant.objective, completionConditions: this.#grant.completionConditions,
      instructions: instructionsFor(this.#grant), readFiles: this.#grant.readFiles, writeFiles: this.#grant.writeFiles,
      checks: TASK_CHECKS, outcome: "human_review_required" as const, limits: TASK_LIMITS };
  }

  close(): void { this.#closed = true; }

  usage(): CandidateTaskUsage {
    return { reads: this.#reads, edits: this.#edits, checks: this.#checks };
  }

  beginExecution(context?: SemanticExecutionContext): CandidateTaskExecution {
    if (this.#closed || this.#busy || this.#activeGeneration !== null) throw new Error("Task execution unavailable");
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#activeGeneration = generation;
    return {
      describe: (): CandidateTaskDescription => {
        const description = this.describe();
        return context === undefined ? { ...description, executionCause: "initial_implementation" } : {
          ...description, executionCause: context.cause,
          semanticRevision: { refinement: context.refinement, parentReviewSha256: context.parentReviewSha256,
            parentWriteSetSha256: context.parentWriteSetSha256, parentCheckSha256: context.parentCheckSha256,
            effectiveCriteriaSha256: context.effectiveCriteriaSha256, parentEvidence: context.parentEvidence,
            remainingBudget: context.remainingBudget },
        };
      },
      requestSchemas: () => this.requestSchemas(),
      read: (request) => this.#read(request, generation),
      replace: (request) => this.#replace(request, generation),
      check: (signal) => this.#check(signal, generation),
      usage: () => this.usage(),
      close: (freeze = false): void => {
        if (this.#activeGeneration === generation) this.#activeGeneration = null;
        if (freeze) this.#closed = true;
      },
    };
  }

  requestSchemas(): ReturnType<typeof taskRequestSchemas> {
    return taskRequestSchemas(this.#grant.readFiles as [string, ...string[]],
      this.#grant.writeFiles as [string, ...string[]]);
  }

  async #operation<T>(action: (snapshot: { checkout: string; files: TaskFiles }) => Promise<T>,
    retainAfterClose: (result: T) => boolean = () => false, generation?: number): Promise<T> {
    if (generation !== undefined && generation !== this.#activeGeneration) throw new Error("Task capability expired");
    if (this.#closed || this.#busy) { this.#closed = true; throw new Error("Task is closed or busy"); }
    this.#busy = true;
    try {
      const snapshot = await observe(this.#directory, this.#plan, this.#grant);
      if (this.#closed || generation !== undefined && generation !== this.#activeGeneration ||
          !sameFiles(snapshot.files, this.#current)) throw new Error("Task source changed externally");
      const result = await action(snapshot);
      if ((this.#closed || generation !== undefined && generation !== this.#activeGeneration) && !retainAfterClose(result)) {
        throw new Error("Task closed");
      }
      return result;
    } catch { this.#closed = true; throw new Error("Task operation denied or unavailable"); }
    finally { this.#busy = false; }
  }

  async read(request: unknown): Promise<{ content: string; sha256: string }> {
    return this.#read(request);
  }

  async #read(request: unknown, generation?: number): Promise<{ content: string; sha256: string }> {
    return this.#operation(async ({ checkout }) => {
      const args = this.requestSchemas().read.parse(request);
      if (this.#reads >= TASK_LIMITS.reads) throw new Error("Read budget exceeded");
      this.#reads += 1;
      const content = await readText(join(checkout, args.path));
      return { content, sha256: hash(content) };
    }, undefined, generation);
  }

  async replace(request: unknown): Promise<void> {
    return this.#replace(request);
  }

  async #replace(request: unknown, generation?: number): Promise<void> {
    return this.#operation(async ({ checkout, files }) => {
      const args = this.requestSchemas().replace.parse(request);
      const currentContent = files[args.path];
      if (currentContent === undefined || this.#checks === 0 || this.#edits >= TASK_LIMITS.edits ||
          args.expectedSha256 !== hash(currentContent)) throw new Error("Edit denied");
      this.#edits += 1;
      const target = join(checkout, args.path);
      const temporary = join(this.#directory, `.tesota-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        try { await file.writeFile(args.content, "utf8"); await file.sync(); } finally { await file.close(); }
      } catch { await unlink(temporary).catch(() => {}); throw new Error("Write failed"); }
      try {
        const current = await observe(this.#directory, this.#plan, this.#grant);
        if (this.#closed || !sameFiles(current.files, files) ||
            relative(dirname(target), await realpath(dirname(target))) !== "") throw new Error("Task changed during edit");
        await rename(temporary, target);
        this.#current = { ...files, [args.path]: args.content };
        const updated = await observe(this.#directory, this.#plan, this.#grant);
        if (!sameFiles(updated.files, this.#current)) throw new Error("Task write mismatch");
      } finally { await unlink(temporary).catch(() => {}); }
    }, undefined, generation);
  }

  async check(signal?: AbortSignal): Promise<CandidateTaskCheck> {
    return this.#check(signal);
  }

  async #check(signal?: AbortSignal, generation?: number): Promise<CandidateTaskCheck> {
    const result = await this.#operation<CandidateTaskCheck>(async ({ files }) => {
      if (this.#checks >= TASK_LIMITS.checks) throw new Error("Check budget exceeded");
      this.#checks += 1;
      const checked = await checkTask(this.#directory, files, this.#plan, this.#grant, signal);
      return { ...checked.oracle, outcome: checked.outcome, settlement: checked.settlement,
        task: TASK_KIND, provenance: "issued", typecheck: checked.typecheck,
        baseline: this.#plan.baseline, writeSetSha256: taskWriteSetSha256(files, this.#grant.writeFiles),
        sourceInputsSha256: sourceInputsSha256(this.#plan),
        taskAcceptance: "not_evaluated" as const };
    }, (check) => check.settlement === "unconfirmed", generation);
    if (result.outcome === "operational_failed") this.close();
    return result;
  }
}

async function loadCandidateTask(directory: string): Promise<{ plan: TaskPlan; grant: ProposalRunGrant; files: TaskFiles }> {
  const parsed = validatePlan(JSON.parse(await readText(join(directory, "task.json"))));
  const baseline = await readCandidateBaselineFiles(directory, parsed.grant.readFiles);
  if (baseline.baseline !== parsed.plan.baseline || !parsed.grant.readFiles.every((path) => {
    const content = baseline.files[path];
    const digest = parsed.plan.inputs[path];
    return content !== undefined && digest !== undefined && (parsed.plan.version === 2
      ? matchesTaskBaseline(digest, content) : hash(content) === digest);
  })) throw new Error("Task baseline changed");
  if (parsed.plan.version === 2) {
    validateTaskSourceInputs(parsed.plan.sourceInputs, parsed.grant.writeFiles, baseline.files);
  }
  const snapshot = await observe(directory, parsed.plan, parsed.grant);
  return { ...parsed, files: snapshot.files };
}

export async function inspectCandidateTask(directory: string): Promise<{
  task: typeof TASK_KIND; baseline: string; definitionSha256: string; writeSetSha256: string; writeFiles: readonly string[];
  sourceInputs: TaskSourceInputs | null; promotable: boolean;
}> {
  const loaded = await loadCandidateTask(directory);
  return { task: TASK_KIND, baseline: loaded.plan.baseline, definitionSha256: loaded.plan.definitionSha256,
    writeSetSha256: taskWriteSetSha256(loaded.files, loaded.grant.writeFiles),
    writeFiles: [...loaded.grant.writeFiles],
    sourceInputs: loaded.plan.version === 2 ? loaded.plan.sourceInputs : null, promotable: loaded.plan.version === 2 };
}

/** Rechecking persisted evidence never reopens editing authority. */
export async function checkCandidateTask(directory: string, signal?: AbortSignal): Promise<CandidateTaskCheck> {
  const loaded = await loadCandidateTask(directory);
  const checked = await checkTask(directory, loaded.files, loaded.plan, loaded.grant, signal);
  return { ...checked.oracle, outcome: checked.outcome, settlement: checked.settlement,
    task: TASK_KIND, typecheck: checked.typecheck,
    provenance: "recorded_untrusted", baseline: loaded.plan.baseline,
    writeSetSha256: taskWriteSetSha256(loaded.files, loaded.grant.writeFiles),
    sourceInputsSha256: sourceInputsSha256(loaded.plan), taskAcceptance: "not_evaluated" };
}
