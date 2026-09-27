import type { VerificationChange } from "./verification-changes.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * How deeply a candidate is reviewed (decision 016). Tesota computes it from
 * facts about the frozen candidate, never from a model, and shows why.
 */
export type ReviewDepth = "standard" | "deep";

export interface DepthDecision {
  readonly depth: ReviewDepth;
  /** Why the review is deep, in words the operator reads; empty for a standard review. */
  readonly reasons: readonly string[];
}

/** Changed lines above this count a change as large; Codex's own review guidance splits complex changes above 500. */
export const LARGE_CHANGE_LINES = 400;

const sensitivePath = new RegExp("(^|/)(auth|authn|authz|security|permissions?|polic(y|ies)|acl|access|crypto|secrets?|" +
  "credentials?|tokens?|sessions?|login|passwords?|payments?|billing|migrations?|infra)(/|\\.|_|-|$)", "iu");
const sensitiveFile = /(^|\/)(Dockerfile[^/]*|[^/]+\.tf|\.github\/workflows\/[^/]+)$/iu;

/** Lines the diff adds or removes, not counting its headers. */
function changedLines(diff: string): number {
  return diff.split("\n").filter((line) => (line.startsWith("+") || line.startsWith("-")) &&
    !line.startsWith("+++") && !line.startsWith("---")).length;
}

/** Test files whose diff removes lines: existing expectations changed, which is how a test is weakened. */
function changedTests(diff: string, flags: readonly VerificationChange[]): string[] {
  const tests = new Set(flags.filter((flag) => flag.kind === "test").map((flag) => flag.path));
  const changed = new Set<string>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/u.exec(line);
    if (header !== null) { current = header[1]; continue; }
    if (current !== undefined && tests.has(current) && line.startsWith("-") && !line.startsWith("---")) changed.add(current);
  }
  for (const flag of flags) if (flag.kind === "test" && flag.status === "deleted") changed.add(flag.path);
  return [...changed];
}

export function reviewDepth(snapshot: Pick<WorkspaceSnapshot, "changes" | "diff">, flags: readonly VerificationChange[],
  checks: readonly CheckResult[]): DepthDecision {
  const reasons: string[] = [];
  const sensitive = snapshot.changes.filter((change) => sensitivePath.test(change.path) || sensitiveFile.test(change.path));
  if (sensitive.length > 0) reasons.push(`touches security- or authority-sensitive files (${sensitive.map((change) => change.path).join(", ")})`);
  const tests = changedTests(snapshot.diff, flags);
  if (tests.length > 0) reasons.push(`changes existing tests (${tests.join(", ")})`);
  const other = flags.filter((flag) => flag.kind !== "test");
  if (other.length > 0) reasons.push(`changes what checks it (${other.map((flag) => `${flag.kind}: ${flag.path}`).join(", ")})`);
  const failed = checks.filter((check) => check.outcome !== "passed");
  if (failed.length > 0) reasons.push(`a verifier did not pass (${failed.map((check) => check.command).join(", ")})`);
  const lines = changedLines(snapshot.diff);
  if (lines > LARGE_CHANGE_LINES) reasons.push(`changes ${lines} lines`);
  return { depth: reasons.length === 0 ? "standard" : "deep", reasons };
}
