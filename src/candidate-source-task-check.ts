import { createHash } from "node:crypto";

export const CANDIDATE_SOURCE_TASK_FILE = "src/verification/candidate.ts";
export const CANDIDATE_SOURCE_TASK_OBJECTIVE =
  "Restore candidate source acceptance for the exact expected declaration with or without its final line feed. Preserve every other byte.";
export const CANDIDATE_SOURCE_TASK_ORACLE =
  "Exact baseline restoration of optional-final-LF candidate acceptance while preserving every other byte.";

const correct = "return source === CANDIDATE_EXPECTED_SOURCE || source === CANDIDATE_EXPECTED_SOURCE.slice(0, -1);";
const defective = "return source === CANDIDATE_EXPECTED_SOURCE && source === CANDIDATE_EXPECTED_SOURCE.slice(0, -1);";
const diagnostic = "Candidate source must accept the expected declaration with or without its final LF";

export interface CandidateSourceTaskCheck {
  readonly status: "passed" | "check_failed";
  readonly diagnostics: readonly string[];
  readonly verifierSha256: string;
}

export function seedCandidateSourceTask(source: string): string {
  if (source.split(correct).length !== 2 || source.includes(defective)) {
    throw new Error("Candidate-source task is not seedable");
  }
  return source.replace(correct, defective);
}

export function candidateSourceTaskVerifierSha256(): string {
  return createHash("sha256").update(
    CANDIDATE_SOURCE_TASK_ORACLE + correct + defective +
    seedCandidateSourceTask.toString() + checkCandidateSourceTask.toString(),
  ).digest("hex");
}

export function checkCandidateSourceTask(
  source: string,
  baseline: string,
): CandidateSourceTaskCheck {
  const verifierSha256 = candidateSourceTaskVerifierSha256();
  return source === baseline
    ? { status: "passed", diagnostics: [], verifierSha256 }
    : { status: "check_failed", diagnostics: [diagnostic], verifierSha256 };
}
