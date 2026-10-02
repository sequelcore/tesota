import { matchesGlob } from "node:path";
import { sensitivePath } from "./verification/sensitive-path-rule.js";
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

/** Terms that name security or authority wherever they appear in a path, part of a longer name included. */
const unambiguousTerm = new RegExp("(^|/)(auth|authn|authz|oauth|security|permissions?|polic(y|ies)|acl|crypto|secrets?|" +
  "credentials?|login|passwords?|payments?|billing|migrations?|infra)(/|\\.|_|-|$)", "iu");
/** Terms that also name ordinary things, as a usage token or a chat session: they count only as a whole folder or file name. */
const wholeAmbiguousTerm = /(^|\/)(tokens?|sessions?|access)(\/|\.[^/.]+$)/iu;
const infrastructureFile = /(^|\/)(Dockerfile[^/]*|[^/]+\.tf|\.github\/workflows\/[^/]+)$/iu;

/** Where a repository declares the paths whose changes always get a thorough review (decision 053). */
export const SENSITIVE_PATHS_FILE = ".tesota/sensitive-paths";
const maxDeclaredPaths = 200;

/** The globs a sensitive-paths file declares, one per line, without blank lines and `#` comments. */
export function parseSensitivePaths(text: string | undefined): readonly string[] {
  if (text === undefined) return [];
  return text.split(/\r?\n/u).map((line) => line.trim().replace(/^\.?\//u, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#")).slice(0, maxDeclaredPaths);
}

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

/**
 * `declared` holds the globs of the repository's sensitive-paths file as the
 * candidate's base holds it, never the candidate's own, which the agent wrote.
 */
export function reviewDepth(snapshot: Pick<WorkspaceSnapshot, "changes" | "diff">, flags: readonly VerificationChange[],
  checks: readonly CheckResult[], declared: readonly string[] = []): DepthDecision {
  const reasons: string[] = [];
  const isDeclared = (path: string): boolean => declared.some((glob) => matchesGlob(path, glob));
  const sensitive = snapshot.changes.map((change) => change.path).filter((path) => sensitivePath(isDeclared(path),
    flags.some((flag) => flag.path === path && flag.kind === "test"), unambiguousTerm.test(path),
    wholeAmbiguousTerm.test(path), infrastructureFile.test(path)));
  const marked = sensitive.filter(isDeclared);
  const named = sensitive.filter((path) => !isDeclared(path));
  if (marked.length > 0) reasons.push(`touches paths this repository marks sensitive (${marked.join(", ")})`);
  if (named.length > 0) reasons.push(`touches security- or authority-sensitive files (${named.join(", ")})`);
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
