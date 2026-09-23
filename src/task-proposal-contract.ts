import * as z from "zod";
import { TASK_CHECKS, SOURCE_TEST_TASK_CHECKS } from "./task-contract.js";

export const PROPOSAL_CHECKS: readonly [typeof TASK_CHECKS[0], typeof TASK_CHECKS[1], typeof SOURCE_TEST_TASK_CHECKS[1]] =
  Object.freeze([TASK_CHECKS[0], TASK_CHECKS[1], SOURCE_TEST_TASK_CHECKS[1]]);
export const PROPOSAL_LIMITS: Readonly<{
  operations: number; listedFiles: number; searchMatches: number; fileBytes: number; scannedBytes: number; exposedBytes: number;
}> = Object.freeze({ operations: 32, listedFiles: 512, searchMatches: 40,
  fileBytes: 128 * 1024, scannedBytes: 8 * 1024 * 1024, exposedBytes: 1024 * 1024 });

export function validProposalPath(path: string): boolean {
  return /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path) &&
    path.split("/").every((part) => part !== "." && part !== ".." && part !== ".git");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

export function modelTextSchema(maximumLength: number): z.ZodString {
  return z.string().trim().min(1).max(maximumLength)
    .refine((value) => !hasControlCharacter(value));
}

const pathSchema = z.string().min(1).max(512).refine((path) => validProposalPath(path));
const prefixSchema = z.string().max(512).refine((prefix) => prefix === "" || validProposalPath(prefix) ||
  prefix.endsWith("/") && validProposalPath(prefix.slice(0, -1)));
const sentenceSchema = modelTextSchema(1_000);
const conditionSchema = modelTextSchema(500);
export interface TaskProposal {
  readonly objective: string;
  readonly completionConditions: readonly string[];
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly string[];
  readonly checks: readonly (typeof PROPOSAL_CHECKS[number])[];
  readonly uncertainties: readonly string[];
}
export const taskProposalSchema: z.ZodType<TaskProposal> = z.strictObject({
  objective: sentenceSchema,
  completionConditions: z.array(conditionSchema).min(1).max(8),
  readFiles: z.array(pathSchema).max(64),
  writeFiles: z.array(pathSchema).min(1).max(16),
  checks: z.array(z.enum(PROPOSAL_CHECKS)).min(1).max(PROPOSAL_CHECKS.length),
  uncertainties: z.array(conditionSchema).max(8),
}).superRefine((proposal, context) => {
  for (const key of ["readFiles", "writeFiles", "checks"] as const) {
    if (new Set(proposal[key]).size !== proposal[key].length) {
      context.addIssue({ code: "custom", message: `${key} must be unique`, path: [key] });
    }
  }
  const reads = new Set(proposal.readFiles);
  for (const path of proposal.writeFiles) {
    if (!reads.has(path)) context.addIssue({ code: "custom", message: "Every write file must be readable", path: ["writeFiles"] });
  }
});

export const proposalListSchema: z.ZodType<{ readonly prefix: string }> =
  z.strictObject({ prefix: prefixSchema });
export const proposalSearchSchema: z.ZodType<{ readonly query: string; readonly prefix: string }> =
  z.strictObject({ query: z.string().min(1).max(200), prefix: prefixSchema });
export const proposalReadSchema: z.ZodType<{ readonly path: string }> = z.strictObject({ path: pathSchema });
