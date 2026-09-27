import { candidateLines, type ChangedFile } from "./diff-lines.js";
import type { Finding, ReviewReport } from "./review.js";
import { checkedOrigin, type FileChange } from "./verification/finding-origin-rule.js";
import type { WorkspaceSnapshot } from "./workspace.js";

/**
 * Tesota checks each reviewer's origin claim against the candidate's diff
 * (decision 018): this module reads the facts from the diff and explains a
 * changed claim; the proved rule in `verification/finding-origin-rule.ts`
 * decides. Unknown origin goes to the operator, never back to the agent.
 */

/** The facts the rule decides on, read from the diff for one finding. */
interface OriginFacts {
  readonly path: string | undefined;
  readonly file: FileChange;
  readonly readable: boolean;
  readonly located: boolean;
  /** The finding's lines the candidate touched, and those it added. */
  readonly touched: readonly number[];
  readonly added: readonly number[];
}

const fileChanges: Readonly<Record<ChangedFile["status"], FileChange>> =
  { added: "created", deleted: "deleted", modified: "modified" };

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(\.\/)+/u, "");
}

function lineRange(finding: Finding): number[] {
  if (finding.line === undefined) return [];
  const end = Math.max(finding.line, finding.endLine ?? finding.line);
  return Array.from({ length: Math.min(end - finding.line + 1, 10_000) }, (_, index) => (finding.line ?? 0) + index);
}

function factsOf(finding: Finding, files: ReadonlyMap<string, ChangedFile>): OriginFacts {
  const path = finding.path === undefined ? undefined : normalized(finding.path);
  const changed = path === undefined ? undefined : files.get(path);
  const lines = lineRange(finding);
  return { path, file: path === undefined ? "none" : changed === undefined ? "untouched" : fileChanges[changed.status],
    readable: changed?.readable ?? false, located: finding.line !== undefined,
    touched: lines.filter((line) => changed?.touched.has(line) === true),
    added: lines.filter((line) => changed?.added.has(line) === true) };
}

function where(lines: readonly number[], finding: Finding, path: string): string {
  const first = lines[0] ?? finding.line;
  const last = lines.at(-1) ?? finding.endLine ?? first;
  if (first === undefined) return path;
  return `${first === last || last === undefined ? `line ${first}` : `lines ${first}-${last}`} of ${path}`;
}

/** Why the diff did not support the reviewer's claim, for the operator. */
function note(finding: Finding, facts: OriginFacts): string {
  const path = facts.path ?? "";
  if (finding.origin === "preexisting") {
    return facts.file === "created" ? `The reviewer said it was already there, but this change created ${path}.`
      : `The reviewer said it was already there, but this change added ${where(facts.added, finding, path)}.`;
  }
  const claim = "The reviewer said this change caused it, but";
  if (facts.file === "none") return `${claim} the finding names no file, so Tesota cannot tell.`;
  if (facts.file === "untouched") return `${claim} this change does not touch ${path}.`;
  if (!facts.readable) return `${claim} Tesota cannot read what changed in ${path}.`;
  if (!facts.located) return `${claim} the finding names no line in ${path}, which existed before.`;
  return `${claim} ${where([], finding, path)} is neither a line this change added nor next to lines it removed.`;
}

function attribute(finding: Finding, files: ReadonlyMap<string, ChangedFile>): Finding {
  const facts = factsOf(finding, files);
  const origin = checkedOrigin(finding.origin, facts.file, facts.readable, facts.located, facts.touched.length > 0,
    facts.added.length > 0);
  return origin === finding.origin ? finding : { ...finding, origin, originNote: note(finding, facts) };
}

/**
 * Check every finding's origin against the whole candidate, base to tree,
 * also in a correction round: whatever the candidate introduced is the
 * agent's to fix, whichever round wrote it.
 */
export function attributeOrigins(reports: readonly ReviewReport[],
  candidate: Pick<WorkspaceSnapshot, "changes" | "diff">): ReviewReport[] {
  const files = candidateLines(candidate);
  return reports.map((report) => report.status === "completed"
    ? { ...report, findings: report.findings.map((finding) => attribute(finding, files)) } : report);
}
