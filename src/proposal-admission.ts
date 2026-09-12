import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { loadTaskProposal } from "./task-proposal.js";
import { runRepositoryGit } from "./repository-git.js";

export const PROPOSAL_TASK_KIND = "proposal-documentation";

export interface ProposalRunGrant {
  readonly kind: typeof PROPOSAL_TASK_KIND;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly source: string;
  readonly baseline: string;
  readonly objective: string;
  readonly completionConditions: readonly string[];
  readonly readFiles: readonly [string, ...string[]];
  readonly writeFiles: readonly [string];
  readonly declaredChecks: readonly ["repository-check"];
  readonly verification: {
    readonly scopeIntegrity: "application_owned";
    readonly repositoryCheck: "not_executed_in_first_slice";
  };
}

function documentationPath(path: string): boolean {
  return path.startsWith("docs/") && path.endsWith(".md") && path.split("/").length >= 2;
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
  if (proposal.writeFiles.length !== 1 || writeFile === undefined || !documentationPath(writeFile) ||
      proposal.readFiles.length === 0 || proposal.readFiles.length > 8 ||
      !proposal.readFiles.includes(writeFile) ||
      proposal.checks.length !== 1 || proposal.checks[0] !== "repository-check") {
    throw new Error("Proposal scope is unsupported");
  }
  return {
    kind: PROPOSAL_TASK_KIND,
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
  };
}
