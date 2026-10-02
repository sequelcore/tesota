import { basename } from "node:path";
import type { WorkspaceChange, WorkspaceSnapshot } from "./workspace.js";

/** What a flagged change can alter about how a candidate is checked (decision 015). */
export type VerificationChangeKind =
  | "test" | "check configuration" | "CI workflow" | "formal specification" | "package scripts" | "Tesota setup";

/** A candidate change to something that checks the candidate; the operator decides whether it is legitimate. */
export interface VerificationChange {
  readonly path: string;
  readonly status: WorkspaceChange["status"];
  readonly kind: VerificationChangeKind;
}

/** Reads a file as a commit or tree holds it; undefined when it is absent there. */
export type RevisionReader = (revision: string, path: string) => string | undefined;

const testPaths = [
  /(^|\/)(__tests__|tests?|specs?)\//u,
  /\.(test|spec)\.[cm]?[jt]sx?$/u,
  /(^|\/)test_[^/]+\.py$/u,
  /_test\.(go|py)$/u,
  /\.snap$/u,
];
const checkConfigurationNames = new RegExp("^(" + [
  "tsconfig(\\..+)?\\.json", "jsconfig\\.json", "\\.oxlintrc(\\..+)?", "oxlint\\.json",
  "\\.eslintrc(\\..+)?", "eslint\\.config\\.[cm]?[jt]s", "biome\\.jsonc?", "\\.prettierrc(\\..+)?",
  "prettier\\.config\\.[cm]?[jt]s", "(vitest|vite|jest|playwright|cypress)\\.(config|workspace)\\.[cm]?[jt]s",
  "pyproject\\.toml", "pytest\\.ini", "tox\\.ini", "setup\\.cfg", "\\.?ruff\\.toml", "mypy\\.ini",
  "\\.golangci\\.ya?ml", "clippy\\.toml", "rustfmt\\.toml",
].join("|") + ")$", "u");
const ciPaths = [/^\.github\/workflows\//u, /^\.gitlab-ci\.ya?ml$/u, /^\.circleci\//u, /^azure-pipelines\.ya?ml$/u,
  /^\.husky\//u, /^lefthook\.ya?ml$/u];
const formalFiles = /\.(dfy|lean|tla)$/u;

function scriptsOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(text);
    const scripts: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "scripts") : undefined;
    return scripts === undefined ? undefined : JSON.stringify(scripts);
  } catch {
    // An unreadable manifest cannot be shown to leave its scripts alone.
    return `unreadable:${text}`;
  }
}

/** Paths whose diff adds or removes a LemmaScript `//@` annotation line. */
function annotatedPaths(diff: string): ReadonlySet<string> {
  const paths = new Set<string>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/u.exec(line);
    if (header !== null) { current = header[1]; continue; }
    if (current === undefined || line.startsWith("+++") || line.startsWith("---")) continue;
    if ((line.startsWith("+") || line.startsWith("-")) && /^[+-]\s*\/\/@/u.test(line)) paths.add(current);
  }
  return paths;
}

/** Whether a path is a test, as every rule that treats tests apart reads it. */
export function isTestPath(path: string): boolean {
  return testPaths.some((pattern) => pattern.test(path));
}

function kindOf(change: WorkspaceChange, snapshot: WorkspaceSnapshot, annotated: ReadonlySet<string>,
  read: RevisionReader): VerificationChangeKind | undefined {
  const { path } = change;
  if (isTestPath(path)) return "test";
  if (path.startsWith(".tesota/")) return "Tesota setup";
  if (ciPaths.some((pattern) => pattern.test(path))) return "CI workflow";
  if (checkConfigurationNames.test(basename(path))) return "check configuration";
  if (formalFiles.test(path) || annotated.has(path)) return "formal specification";
  if (basename(path) === "package.json" &&
    scriptsOf(read(snapshot.base, path)) !== scriptsOf(read(snapshot.tree, path))) return "package scripts";
  return undefined;
}

/**
 * The candidate's changes to what checks it: tests, check and lint
 * configuration, CI, formal specifications, package scripts and Tesota's own
 * setup. Fixed rules, so the agent cannot argue a change out of the list.
 */
export function flagVerificationChanges(snapshot: WorkspaceSnapshot, read: RevisionReader): readonly VerificationChange[] {
  const annotated = annotatedPaths(snapshot.diff);
  return snapshot.changes.flatMap((change) => {
    const kind = kindOf(change, snapshot, annotated, read);
    return kind === undefined ? [] : [{ path: change.path, status: change.status, kind }];
  });
}
