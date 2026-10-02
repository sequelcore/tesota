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
const unambiguousTerm = new RegExp("(^|/)(auth|authn|authz|oauth|security|permissions?|polic(y|ies)|acl|crypto|secrets?|sandbox(es)?|" +
  "credentials?|login|passwords?|payments?|billing|migrations?|infra)(/|\\.|_|-|$)", "iu");
/** Terms that also name ordinary things, as a usage token or a chat session: they count only as a whole folder or file name. */
const wholeAmbiguousTerm = /(^|\/)(tokens?|sessions?|access)(\/|\.[^/.]+$)/iu;
const infrastructureFile = /(^|\/)(Dockerfile[^/]*|[^/]+\.tf|\.github\/workflows\/[^/]+)$/iu;

/** Where a repository declares the paths whose changes always get a thorough review (decision 053). */
export const SENSITIVE_PATHS_FILE = ".tesota/sensitive-paths";
const maxDeclaredPaths = 200;

function glob(text: string): string { return text.trim().replace(/^\.?\//u, ""); }

/** The globs a sensitive-paths file declares, one per line, without blank lines and `#` comments. */
export function parseSensitivePaths(text: string | undefined): readonly string[] {
  if (text === undefined) return [];
  return text.split(/\r?\n/u).map(glob).filter((line) => line.length > 0 && !line.startsWith("#")).slice(0, maxDeclaredPaths);
}

/**
 * Imports of process, cryptography and network APIs, in JavaScript and
 * TypeScript, Python, Go and Rust: code that can run programs, hold secrets or
 * reach the network, as static analysis treats them as sinks.
 */
const authorityImport = new RegExp([
  "(from\\s+|require\\(\\s*|import\\s+)[\"'](node:)?(child_process|crypto|net|tls|http|https|http2|vm|worker_threads)[\"']",
  "^\\s*(import|from)\\s+(subprocess|socket|ssl|hashlib|hmac|secrets|ctypes)\\b",
  "\"(os/exec|net|net/http|crypto/[a-z0-9/]+|syscall)\"",
  "\\b(std::process|std::net|openssl|rustls|ring::)",
].join("|"), "mu");

/** Whether code imports process, cryptography or network APIs. */
export function importsAuthority(text: string | undefined): boolean {
  return text !== undefined && authorityImport.test(text);
}

/**
 * What marks a path sensitive: the globs the repository's file declares, as
 * the candidate's base holds it; whether the repository declares a list,
 * after which imports no longer count; and whether a changed file imports
 * process, cryptography or network APIs, on either side of the change.
 */
export interface Sensitivity {
  readonly declared: readonly string[];
  readonly confirmed: boolean;
  importsAuthority(path: string): boolean;
}

const namesOnly: Sensitivity = { declared: [], confirmed: true, importsAuthority: () => false };

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
 * `sensitivity.declared` holds the repository's file as the candidate's base
 * holds it, never the candidate's own, which the agent wrote.
 */
export function reviewDepth(snapshot: Pick<WorkspaceSnapshot, "changes" | "diff">, flags: readonly VerificationChange[],
  checks: readonly CheckResult[], sensitivity: Sensitivity = namesOnly): DepthDecision {
  const reasons: string[] = [];
  const isDeclared = (path: string): boolean => sensitivity.declared.some((pattern) => matchesGlob(path, pattern));
  const sensitive = snapshot.changes.map((change) => change.path).filter((path) => sensitivePath(isDeclared(path),
    sensitivity.confirmed, flags.some((flag) => flag.path === path && flag.kind === "test"), unambiguousTerm.test(path),
    wholeAmbiguousTerm.test(path), infrastructureFile.test(path), sensitivity.importsAuthority(path)));
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
