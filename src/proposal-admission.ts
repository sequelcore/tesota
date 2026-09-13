import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import * as z from "zod";
import { loadTaskProposal } from "./task-proposal.js";
import { runRepositoryGit } from "./repository-git.js";
import { isRepositoryDiscoveryPathAllowed } from "./repository-discovery.js";
import { validProposalPath, type TaskProposal } from "./task-proposal-contract.js";
import { candidateTaskDefinition } from "./candidate-task-definition.js";
import { CODE_TASK_FILE } from "./code-task-check.js";

export const DOCUMENTATION_PROPOSAL_TASK_KIND = "proposal-documentation";
export const CODE_PROPOSAL_TASK_KIND = "proposal-code";
export const CODE_PROPOSAL_TASK_ID = "pi-result-consistency";
export const CODE_PROPOSAL_TEST_FILE = "tests/candidate-task.test.ts";
export const PROPOSAL_TASK_KINDS: readonly [
  typeof DOCUMENTATION_PROPOSAL_TASK_KIND,
  typeof CODE_PROPOSAL_TASK_KIND,
] = [DOCUMENTATION_PROPOSAL_TASK_KIND, CODE_PROPOSAL_TASK_KIND];

interface ProposalGrantBase {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly source: string;
  readonly baseline: string;
  readonly objective: string;
  readonly completionConditions: readonly string[];
}

export interface DocumentationProposalRunGrant extends ProposalGrantBase {
  readonly kind: typeof DOCUMENTATION_PROPOSAL_TASK_KIND;
  readonly readFiles: readonly string[];
  readonly writeFiles: readonly [string];
  readonly declaredChecks: readonly ["repository-check"];
  readonly verification: {
    readonly scopeIntegrity: "application_owned";
    readonly repositoryCheck: "not_executed_in_first_slice";
  };
}

export interface CodeProposalRunGrant extends ProposalGrantBase {
  readonly kind: typeof CODE_PROPOSAL_TASK_KIND;
  readonly task: typeof CODE_PROPOSAL_TASK_ID;
  readonly readFiles: readonly [typeof CODE_TASK_FILE, typeof CODE_PROPOSAL_TEST_FILE];
  readonly writeFiles: readonly [typeof CODE_TASK_FILE, typeof CODE_PROPOSAL_TEST_FILE];
  readonly declaredChecks: readonly [typeof CODE_PROPOSAL_TASK_ID];
  readonly verification: {
    readonly scopeIntegrity: "application_owned";
    readonly behaviorCheck: "pinned_container";
  };
}

export type ProposalRunGrant = DocumentationProposalRunGrant | CodeProposalRunGrant;

function documentationPath(path: string): boolean {
  return path.startsWith("docs/") && path.endsWith(".md") && path.split("/").length >= 2;
}

const grantShape = {
  proposalId: z.uuid(), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.string().refine(isAbsolute), baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  objective: z.string().min(1).max(4_000), completionConditions: z.array(z.string().min(1).max(1_000)).min(1).max(8),
} as const;
const documentationGrantSchema = z.strictObject({
  ...grantShape, kind: z.literal(DOCUMENTATION_PROPOSAL_TASK_KIND),
  readFiles: z.array(z.string().refine(validProposalPath)).min(1).max(8),
  writeFiles: z.tuple([z.string().refine(validProposalPath)]),
  declaredChecks: z.tuple([z.literal("repository-check")]),
  verification: z.strictObject({ scopeIntegrity: z.literal("application_owned"),
    repositoryCheck: z.literal("not_executed_in_first_slice") }),
}).refine((grant) => documentationPath(grant.writeFiles[0]) && grant.readFiles.includes(grant.writeFiles[0]) &&
  grant.readFiles.every(isRepositoryDiscoveryPathAllowed));
const codeGrantSchema = z.strictObject({
  ...grantShape, kind: z.literal(CODE_PROPOSAL_TASK_KIND), task: z.literal(CODE_PROPOSAL_TASK_ID),
  readFiles: z.tuple([z.literal(CODE_TASK_FILE), z.literal(CODE_PROPOSAL_TEST_FILE)]),
  writeFiles: z.tuple([z.literal(CODE_TASK_FILE), z.literal(CODE_PROPOSAL_TEST_FILE)]),
  declaredChecks: z.tuple([z.literal(CODE_PROPOSAL_TASK_ID)]),
  verification: z.strictObject({ scopeIntegrity: z.literal("application_owned"),
    behaviorCheck: z.literal("pinned_container") }),
});
const proposalRunGrantSchema: z.ZodType<ProposalRunGrant> =
  z.discriminatedUnion("kind", [documentationGrantSchema, codeGrantSchema]);

export function validateProposalRunGrant(value: unknown): ProposalRunGrant {
  const parsed = proposalRunGrantSchema.parse(value);
  return parsed;
}

function supportsDocumentationProposal(proposal: TaskProposal): boolean {
  const writeFile = proposal.writeFiles[0];
  return proposal.writeFiles.length === 1 && writeFile !== undefined && documentationPath(writeFile) &&
    proposal.readFiles.length > 0 && proposal.readFiles.length <= 8 && proposal.readFiles.includes(writeFile) &&
    proposal.readFiles.every(isRepositoryDiscoveryPathAllowed) &&
    proposal.checks.length === 1 && proposal.checks[0] === "repository-check";
}

function supportsCodeProposal(proposal: TaskProposal): boolean {
  const proposedReads = new Set(proposal.readFiles);
  return proposal.writeFiles.length === 2 && proposal.writeFiles[0] === CODE_TASK_FILE &&
    proposal.writeFiles[1] === CODE_PROPOSAL_TEST_FILE &&
    proposedReads.has(CODE_TASK_FILE) && proposedReads.has(CODE_PROPOSAL_TEST_FILE) &&
    proposal.readFiles.length <= 8 &&
    proposal.checks.length === 1 && proposal.checks[0] === CODE_PROPOSAL_TASK_ID &&
    proposal.readFiles.every(isRepositoryDiscoveryPathAllowed);
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
  if (relative(source, recordedSource) !== "" || loaded.record.status !== "ready" ||
      loaded.record.authority !== "none" || loaded.record.dirtyConflicts.length !== 0) {
    throw new Error("Proposal is not admissible");
  }
  const head = runRepositoryGit(source, ["rev-parse", "HEAD"]).trim();
  if (head !== loaded.record.baseline) throw new Error("Proposal baseline is stale");
  const { proposal } = loaded.record;
  const writeFile = proposal.writeFiles[0];
  if (supportsDocumentationProposal(proposal) && writeFile !== undefined) {
    return validateProposalRunGrant({
      kind: DOCUMENTATION_PROPOSAL_TASK_KIND,
      proposalId: loaded.record.id,
      proposalSha256: loaded.sha256,
      source,
      baseline: head,
      objective: proposal.objective,
      completionConditions: [...proposal.completionConditions],
      readFiles: [...proposal.readFiles] as [string, ...string[]],
      writeFiles: [writeFile],
      declaredChecks: ["repository-check"],
      verification: { scopeIntegrity: "application_owned", repositoryCheck: "not_executed_in_first_slice" },
    });
  }
  if (!supportsCodeProposal(proposal)) throw new Error("Proposal scope is unsupported");
  const definition = candidateTaskDefinition(CODE_PROPOSAL_TASK_ID);
  return validateProposalRunGrant({
    kind: CODE_PROPOSAL_TASK_KIND,
    task: CODE_PROPOSAL_TASK_ID,
    proposalId: loaded.record.id,
    proposalSha256: loaded.sha256,
    source,
    baseline: head,
    objective: definition.objective,
    completionConditions: [definition.oracle],
    readFiles: [CODE_TASK_FILE, CODE_PROPOSAL_TEST_FILE],
    writeFiles: [CODE_TASK_FILE, CODE_PROPOSAL_TEST_FILE],
    declaredChecks: [CODE_PROPOSAL_TASK_ID],
    verification: { scopeIntegrity: "application_owned", behaviorCheck: "pinned_container" },
  });
}
