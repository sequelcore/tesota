import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import * as z from "zod";
import { loadTaskProposal } from "./task-proposal.js";
import { runRepositoryGit } from "./repository-git.js";
import { isRepositoryDiscoveryPathAllowed } from "./repository-discovery.js";
import { regressionTestPath, validProposalPath, type TaskProposal } from "./task-proposal-contract.js";
import { SOURCE_TEST_TASK_CHECKS, SOURCE_TEST_TASK_KIND, TASK_CHECKS, TASK_KIND } from "./task-contract.js";

interface ProposalGrantBase {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly source: string;
  readonly baseline: string;
  readonly objective: string;
  readonly completionConditions: readonly string[];
}

export interface SourceOnlyRunGrant extends ProposalGrantBase {
  readonly kind: typeof TASK_KIND;
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly string[];
  readonly declaredChecks: typeof TASK_CHECKS;
  readonly verification: {
    readonly scopeIntegrity: "application_owned";
    readonly typecheck: "typescript-no-emit/v1";
    readonly outcome: "human_review_required";
  };
}

export interface SourceTestRunGrant extends ProposalGrantBase {
  readonly kind: typeof SOURCE_TEST_TASK_KIND;
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly string[];
  readonly selectedTest: string;
  readonly declaredChecks: typeof SOURCE_TEST_TASK_CHECKS;
  readonly verification: {
    readonly scopeIntegrity: "application_owned";
    readonly nodeTest: "node-test-targeted/v1";
    readonly outcome: "human_review_required";
  };
}

export type ProposalRunGrant = SourceOnlyRunGrant | SourceTestRunGrant;

function typescriptSourcePath(path: string): boolean {
  return path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".d.ts") &&
    !/(?:^|\/)(?:__tests__)(?:\/)|\.(?:test|spec)\.ts$/u.test(path) && path.split("/").length >= 2;
}

const grantShape = {
  proposalId: z.uuid(), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.string().refine(isAbsolute), baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  objective: z.string().min(1).max(4_000), completionConditions: z.array(z.string().min(1).max(1_000)).min(1).max(8),
} as const;
const sourceOnlyGrantSchema: z.ZodType<SourceOnlyRunGrant> = z.strictObject({
  ...grantShape, kind: z.literal(TASK_KIND),
  readFiles: z.array(z.string().refine(validProposalPath)).min(1).max(8),
  writeFiles: z.array(z.string().refine(validProposalPath)).min(1).max(2),
  declaredChecks: z.tuple([z.literal(TASK_CHECKS[0]), z.literal(TASK_CHECKS[1])]),
  verification: z.strictObject({ scopeIntegrity: z.literal("application_owned"),
    typecheck: z.literal(TASK_CHECKS[1]),
    outcome: z.literal("human_review_required") }),
}).refine((grant) => grant.writeFiles.every((path) => typescriptSourcePath(path) && grant.readFiles.includes(path)) &&
  grant.readFiles.every(isRepositoryDiscoveryPathAllowed) && new Set(grant.writeFiles).size === grant.writeFiles.length);

function sourceTestPath(path: string): boolean {
  return path.endsWith(".ts") && !path.endsWith(".d.ts") &&
    !/^(?:tests|scripts|config|\.github)\//u.test(path) &&
    !/(?:^|\/)__tests__\/|\.(?:test|spec|config|setup)\.ts$/u.test(path);
}

const sourceTestGrantSchema: z.ZodType<SourceTestRunGrant> = z.strictObject({
  ...grantShape, kind: z.literal(SOURCE_TEST_TASK_KIND),
  readFiles: z.array(z.string().refine(validProposalPath)).min(2).max(8),
  writeFiles: z.array(z.string().refine(validProposalPath)).length(2),
  selectedTest: z.string().refine(regressionTestPath),
  declaredChecks: z.tuple([z.literal(SOURCE_TEST_TASK_CHECKS[0]), z.literal(SOURCE_TEST_TASK_CHECKS[1])]),
  verification: z.strictObject({ scopeIntegrity: z.literal("application_owned"),
    nodeTest: z.literal(SOURCE_TEST_TASK_CHECKS[1]), outcome: z.literal("human_review_required") }),
}).refine((grant) => grant.writeFiles.filter(sourceTestPath).length === 1 &&
  grant.writeFiles.filter(regressionTestPath).length === 1 && grant.writeFiles.includes(grant.selectedTest) &&
  grant.writeFiles.every((path) => grant.readFiles.includes(path)) &&
  grant.readFiles.every(isRepositoryDiscoveryPathAllowed) && new Set(grant.writeFiles).size === 2);

export function validateProposalRunGrant(value: unknown): ProposalRunGrant {
  const kind = z.object({ kind: z.string() }).parse(value).kind;
  return kind === SOURCE_TEST_TASK_KIND ? sourceTestGrantSchema.parse(value) : sourceOnlyGrantSchema.parse(value);
}

function supportsTypescriptProposal(proposal: TaskProposal): boolean {
  const writeFile = proposal.writeFiles[0];
  return proposal.writeFiles.length >= 1 && proposal.writeFiles.length <= 2 && writeFile !== undefined &&
    proposal.writeFiles.every(typescriptSourcePath) &&
    proposal.readFiles.length > 0 && proposal.readFiles.length <= 8 && proposal.readFiles.includes(writeFile) &&
    proposal.writeFiles.every((path) => proposal.readFiles.includes(path)) &&
    proposal.readFiles.every(isRepositoryDiscoveryPathAllowed) &&
    proposal.checks.length === 2 && proposal.checks[0] === TASK_CHECKS[0] && proposal.checks[1] === TASK_CHECKS[1];
}

function supportsSourceTestProposal(proposal: TaskProposal): boolean {
  return proposal.writeFiles.length === 2 && proposal.writeFiles.filter(sourceTestPath).length === 1 &&
    proposal.writeFiles.filter(regressionTestPath).length === 1 &&
    proposal.readFiles.length >= 2 && proposal.readFiles.length <= 8 &&
    proposal.writeFiles.every((path) => proposal.readFiles.includes(path)) &&
    proposal.readFiles.every(isRepositoryDiscoveryPathAllowed) &&
    proposal.checks.length === 2 && proposal.checks[0] === SOURCE_TEST_TASK_CHECKS[0] &&
    proposal.checks[1] === SOURCE_TEST_TASK_CHECKS[1];
}

/** Structural preview only; admission still rechecks source identity, status and the current policy. */
export function supportedProposalKind(proposal: TaskProposal): typeof TASK_KIND | typeof SOURCE_TEST_TASK_KIND | null {
  if (supportsTypescriptProposal(proposal)) return TASK_KIND;
  if (supportsSourceTestProposal(proposal)) return SOURCE_TEST_TASK_KIND;
  return null;
}

/** Issue the first narrow run grant from untrusted proposal evidence and current repository state. */
export async function admitTaskProposal(options: {
  readonly proposalsRoot: string;
  readonly reference: string;
  readonly sourceDirectory: string;
}): Promise<ProposalRunGrant> {
  const loaded = await loadTaskProposal(options.proposalsRoot, options.reference);
  const source = await realpath(options.sourceDirectory);
  const recordedSource = await realpath(loaded.record.source);
  if (relative(source, recordedSource) !== "") throw new Error("Proposal is not admissible");
  if (loaded.record.status === "blocked_scope") throw new Error("Proposal scope is unsupported");
  if (loaded.record.status !== "ready" ||
      loaded.record.authority !== "none" || loaded.record.dirtyConflicts.length !== 0) {
    throw new Error("Proposal is not admissible");
  }
  const head = runRepositoryGit(source, ["rev-parse", "HEAD"]).trim();
  if (head !== loaded.record.baseline) throw new Error("Proposal baseline is stale");
  const { proposal } = loaded.record;
  const kind = supportedProposalKind(proposal);
  if (kind === TASK_KIND) {
    return validateProposalRunGrant({
      kind: TASK_KIND,
      proposalId: loaded.record.id,
      proposalSha256: loaded.sha256,
      source,
      baseline: head,
      objective: proposal.objective,
      completionConditions: [...proposal.completionConditions],
      readFiles: [...proposal.readFiles] as [string, ...string[]],
      writeFiles: [...proposal.writeFiles] as [string, ...string[]],
      declaredChecks: TASK_CHECKS,
      verification: { scopeIntegrity: "application_owned", typecheck: "typescript-no-emit/v1",
        outcome: "human_review_required" },
    });
  }
  if (kind === SOURCE_TEST_TASK_KIND) {
    const selectedTest = proposal.writeFiles.find(regressionTestPath);
    if (selectedTest === undefined) throw new Error("Proposal test scope unsupported");
    return validateProposalRunGrant({
      kind: SOURCE_TEST_TASK_KIND, proposalId: loaded.record.id, proposalSha256: loaded.sha256,
      source, baseline: head, objective: proposal.objective,
      completionConditions: [...proposal.completionConditions], readFiles: [...proposal.readFiles],
      writeFiles: [...proposal.writeFiles], selectedTest, declaredChecks: SOURCE_TEST_TASK_CHECKS,
      verification: { scopeIntegrity: "application_owned", nodeTest: "node-test-targeted/v1",
        outcome: "human_review_required" },
    });
  }
  throw new Error("Proposal scope is unsupported");
}
