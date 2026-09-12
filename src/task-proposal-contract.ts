import * as z from "zod";

export const PROPOSAL_CHECKS = ["repository-check"] as const;
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

const pathSchema = z.string().min(1).max(512).refine((path) => validProposalPath(path));
const sentenceSchema = z.string().trim().min(1).max(1_000)
  .refine((value) => !hasControlCharacter(value));
const conditionSchema = z.string().trim().min(1).max(500)
  .refine((value) => !hasControlCharacter(value));
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
  z.strictObject({ prefix: pathSchema.or(z.literal("")) });
export const proposalSearchSchema: z.ZodType<{ readonly query: string; readonly prefix: string }> =
  z.strictObject({ query: z.string().min(1).max(200), prefix: pathSchema.or(z.literal("")) });
export const proposalReadSchema: z.ZodType<{ readonly path: string }> = z.strictObject({ path: pathSchema });
