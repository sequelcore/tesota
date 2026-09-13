import { createHash } from "node:crypto";
import * as z from "zod";
import { CODE_TASK_FILE, CODE_TASK_OBJECTIVE, checkCodeTask, codeTaskVerifierSha256 } from "./code-task-check.js";
import {
  FORMAL_TASK_FILE,
  FORMAL_TASK_OBJECTIVE,
  checkFormalTask,
  formalTaskContractSha256,
  seedFormalTask,
} from "./formal-task-check.js";
import {
  CANDIDATE_SOURCE_TASK_FILE,
  CANDIDATE_SOURCE_TASK_OBJECTIVE,
  CANDIDATE_SOURCE_TASK_ORACLE,
  candidateSourceTaskVerifierSha256,
  checkCandidateSourceTask,
  seedCandidateSourceTask,
} from "./candidate-source-task-check.js";
import {
  MULTI_FILE_TASK_FILES,
  MULTI_FILE_TASK_OBJECTIVE,
  MULTI_FILE_TASK_ORACLE,
  checkMultiFileTask,
  multiFileTaskVerifierSha256,
  expectedMultiFileTask,
} from "./multi-file-task-check.js";

export const DEFAULT_CANDIDATE_TASK_ID = "pi-decision-status";
export const PI_DECISION_TASK_FILE = "docs/decisions/002-use-pi.md";
export const CANDIDATE_TASK_LIMITS: Readonly<{
  reads: number;
  edits: number;
  checks: number;
  fileBytes: number;
}> = Object.freeze({ reads: 8, edits: 2, checks: 3, fileBytes: 64 * 1024 });
export const PI_DECISION_TASK_STATUS = "Status: adopted for the current experiments. Synthetic compatibility, live model-turn,\nverification-tool and candidate-correction experiments have passed. A bounded Pi\nCoding Agent host task and an immutable four-lens Gentle review have also\npassed. The first verified self-development cycle was accepted and promoted; a\ncombined correction cycle remains open.";
export const CANDIDATE_TASK_IDS: readonly [
  "pi-decision-status",
  "pi-result-consistency",
  "formal-invocation-admission",
  "candidate-source-newline",
  "multi-file-task-status",
] = [
  "pi-decision-status",
  "pi-result-consistency",
  "formal-invocation-admission",
  "candidate-source-newline",
  "multi-file-task-status",
];
export type CandidateTaskId = (typeof CANDIDATE_TASK_IDS)[number];

const oldDecisionStatus = "Status: adopted for the current experiments. Synthetic compatibility, live model-turn,\nverification-tool and candidate-correction experiments have passed. A bounded Pi\nCoding Agent host task has also passed; the first verified self-development\ncycle has been accepted and promoted, while Gentle high-risk review remains\nopen.";
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface TaskReadRequest {
  readonly path: string;
}

export interface TaskReplaceRequest {
  readonly path: string;
  readonly expectedSha256: string;
  readonly content: string;
}

export interface CandidateTaskOracleResult {
  readonly status: "passed" | "check_failed";
  readonly diagnostics?: readonly string[];
  readonly verifierSha256?: string;
}

export interface CandidateTaskContract {
  readonly objective: string;
  readonly oracle: string;
  readonly oracleSha256: string;
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly [string, ...string[]];
  readonly requiredStatus: string;
  readonly limits: typeof CANDIDATE_TASK_LIMITS;
  readonly effects: readonly ["read_candidate", "replace_candidate_file", "run_task_check"];
  readonly promotion: "allowed" | "denied";
}

export interface CandidateTaskDefinition {
  readonly version: number;
  readonly objective: string;
  readonly oracle: string;
  readonly oracleSha256: string;
  readonly instructions: string;
  readonly readFiles: readonly [string, ...string[]];
  readonly writeFiles: readonly [string, ...string[]];
  readonly requiredStatus: string;
  readonly promotable: boolean;
  readonly seed?: (files: Readonly<Record<string, string>>) => Readonly<Record<string, string>>;
  readonly expected: (files: Readonly<Record<string, string>>) => Readonly<Record<string, string>>;
  readonly check: (files: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>) => CandidateTaskOracleResult;
}

function requiredFile(files: Readonly<Record<string, string>>, path: string): string {
  const content = files[path];
  if (content === undefined) throw new Error("Task baseline changed");
  return content;
}

function exactExpected(files: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): CandidateTaskOracleResult {
  return { status: Object.keys(expected).every((path) => files[path] === expected[path]) ? "passed" : "check_failed" };
}

function oneFile(path: string, content: string): Readonly<Record<string, string>> { return { [path]: content }; }

const definitions: Readonly<Record<CandidateTaskId, CandidateTaskDefinition>> = {
  "pi-decision-status": {
    version: 1,
    objective: "Correct the outdated Pi integration status. Replace only its status paragraph, preserving every other byte.",
    oracle: "Exact replacement of the outdated status paragraph while preserving every other byte.",
    oracleSha256: createHash("sha256").update(oldDecisionStatus + PI_DECISION_TASK_STATUS).digest("hex"),
    instructions: "Read the admitted context, check before editing, replace only the outdated status paragraph with the required status, then check again.",
    readFiles: [PI_DECISION_TASK_FILE, "docs/roadmap.md", "experiments/codex/history.md"],
    writeFiles: [PI_DECISION_TASK_FILE],
    requiredStatus: PI_DECISION_TASK_STATUS,
    promotable: true,
    expected: (files) => {
      const baseline = requiredFile(files, PI_DECISION_TASK_FILE);
      if (baseline.split(oldDecisionStatus).length !== 2) throw new Error("Task is not applicable to this baseline");
      return oneFile(PI_DECISION_TASK_FILE, baseline.replace(oldDecisionStatus, PI_DECISION_TASK_STATUS));
    },
    check: exactExpected,
  },
  "pi-result-consistency": {
    version: 1,
    objective: CODE_TASK_OBJECTIVE,
    oracle: "Pinned isolated Node behavior cases for session evidence consistency.",
    oracleSha256: codeTaskVerifierSha256(),
    instructions: "Read src/integrations/pi-task.ts, check it, replace only the body of piTaskPasses, then check again. Preserve every byte before the export declaration and every declaration after its closing brace, including imports. The edited pure function must use JavaScript syntax inside its existing TypeScript signature, no imports, external declarations or PI_TASK_LIMITS reference; use numeric bounds 10, 13 and 2 inside the function.",
    readFiles: [CODE_TASK_FILE],
    writeFiles: [CODE_TASK_FILE],
    requiredStatus: "",
    promotable: true,
    expected: (files) => oneFile(CODE_TASK_FILE, requiredFile(files, CODE_TASK_FILE)),
    check: (files, expected) => checkCodeTask(requiredFile(files, CODE_TASK_FILE), requiredFile(expected, CODE_TASK_FILE)),
  },
  "formal-invocation-admission": {
    version: 1,
    objective: FORMAL_TASK_OBJECTIVE,
    oracle: "LemmaScript contract verification with the Dafny backend.",
    oracleSha256: formalTaskContractSha256(),
    instructions: "Read src/verification/invocation-admission.ts, check it, replace only the function implementation while preserving every contract annotation and surrounding byte, then check again. Do not weaken, remove or contradict the contract.",
    readFiles: [FORMAL_TASK_FILE],
    writeFiles: [FORMAL_TASK_FILE],
    requiredStatus: "",
    promotable: false,
    seed: (files) => oneFile(FORMAL_TASK_FILE, seedFormalTask(requiredFile(files, FORMAL_TASK_FILE))),
    expected: (files) => oneFile(FORMAL_TASK_FILE, requiredFile(files, FORMAL_TASK_FILE)),
    check: (files) => checkFormalTask(requiredFile(files, FORMAL_TASK_FILE)),
  },
  "candidate-source-newline": {
    version: 1,
    objective: CANDIDATE_SOURCE_TASK_OBJECTIVE,
    oracle: CANDIDATE_SOURCE_TASK_ORACLE,
    oracleSha256: candidateSourceTaskVerifierSha256(),
    instructions: "Read src/verification/candidate.ts, check it, restore optional-final-LF acceptance in candidateSatisfiesTask, preserve every other byte, then check again.",
    readFiles: [CANDIDATE_SOURCE_TASK_FILE],
    writeFiles: [CANDIDATE_SOURCE_TASK_FILE],
    requiredStatus: "",
    promotable: false,
    seed: (files) => oneFile(CANDIDATE_SOURCE_TASK_FILE, seedCandidateSourceTask(requiredFile(files, CANDIDATE_SOURCE_TASK_FILE))),
    expected: (files) => oneFile(CANDIDATE_SOURCE_TASK_FILE, requiredFile(files, CANDIDATE_SOURCE_TASK_FILE)),
    check: (files, expected) => checkCandidateSourceTask(requiredFile(files, CANDIDATE_SOURCE_TASK_FILE), requiredFile(expected, CANDIDATE_SOURCE_TASK_FILE)),
  },
  "multi-file-task-status": {
    version: 1,
    objective: MULTI_FILE_TASK_OBJECTIVE,
    oracle: MULTI_FILE_TASK_ORACLE,
    oracleSha256: multiFileTaskVerifierSha256(),
    instructions: "Read both admitted files, check them, restore the multi-file status in each file with separate replacements, then check again. Preserve every other byte.",
    readFiles: MULTI_FILE_TASK_FILES,
    writeFiles: MULTI_FILE_TASK_FILES,
    requiredStatus: "",
    promotable: true,
    expected: expectedMultiFileTask,
    check: checkMultiFileTask,
  },
};

Object.freeze(CANDIDATE_TASK_IDS);
for (const definition of Object.values(definitions)) {
  Object.freeze(definition.readFiles);
  Object.freeze(definition.writeFiles);
  Object.freeze(definition);
}
Object.freeze(definitions);

export function parseCandidateTaskId(value: string): CandidateTaskId | null {
  return CANDIDATE_TASK_IDS.find((id) => id === value) ?? null;
}

export function candidateTaskDefinition(id: CandidateTaskId): CandidateTaskDefinition {
  const definition = definitions[id];
  const paths = [...definition.readFiles, ...definition.writeFiles];
  const validPath = (path: string): boolean => /^[A-Za-z0-9._/-]+$/u.test(path) &&
    !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "." || part === ".." || part === ".git");
  if (!definition.writeFiles.every((path) => definition.readFiles.includes(path)) ||
      definition.writeFiles.length === 0 || definition.writeFiles.length > CANDIDATE_TASK_LIMITS.edits ||
      definition.readFiles.length > CANDIDATE_TASK_LIMITS.reads ||
      new Set(definition.writeFiles).size !== definition.writeFiles.length ||
      new Set(definition.readFiles).size !== definition.readFiles.length ||
      !paths.every(validPath)) throw new Error("Registered task definition is invalid");
  return definition;
}

export function candidateTaskContract(id: CandidateTaskId): CandidateTaskContract {
  const definition = candidateTaskDefinition(id);
  return {
    objective: definition.objective,
    oracle: definition.oracle,
    oracleSha256: definition.oracleSha256,
    readFiles: [...definition.readFiles],
    writeFiles: [...definition.writeFiles],
    requiredStatus: definition.requiredStatus,
    limits: CANDIDATE_TASK_LIMITS,
    effects: ["read_candidate", "replace_candidate_file", "run_task_check"],
    promotion: definition.promotable ? "allowed" : "denied",
  };
}

export function candidateTaskDefinitionSha256(id: CandidateTaskId): string {
  const definition = candidateTaskDefinition(id);
  return createHash("sha256").update(JSON.stringify({
    task: id,
    version: definition.version,
    instructions: definition.instructions,
    contract: candidateTaskContract(id),
  })).digest("hex");
}

export function taskRequestSchemas(id: CandidateTaskId = DEFAULT_CANDIDATE_TASK_ID): {
  read: z.ZodType<TaskReadRequest>;
  replace: z.ZodType<TaskReplaceRequest>;
  check: z.ZodType<Record<string, never>>;
} {
  const definition = candidateTaskDefinition(id);
  return scopedTaskRequestSchemas(definition.readFiles, definition.writeFiles);
}

export function scopedTaskRequestSchemas(readFiles: readonly [string, ...string[]],
  writeFiles: readonly [string, ...string[]]): {
  read: z.ZodType<TaskReadRequest>;
  replace: z.ZodType<TaskReplaceRequest>;
  check: z.ZodType<Record<string, never>>;
} {
  const content = z.string().max(CANDIDATE_TASK_LIMITS.fileBytes).refine((text) =>
    Buffer.byteLength(text) <= CANDIDATE_TASK_LIMITS.fileBytes &&
    !text.includes("\0") && Buffer.from(text).toString("utf8") === text);
  return {
    read: z.strictObject({ path: z.enum(readFiles) }),
    replace: z.strictObject({
      path: z.enum(writeFiles),
      expectedSha256: hashSchema,
      content,
    }),
    check: z.strictObject({}),
  };
}
