import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hostProvider } from "../host-environment.js";
import type { WorkspaceSnapshot } from "../workspace.js";
import type { CheckResult } from "../workspace-checks.js";
import { configuredOxlint, runOxlint } from "./oxlint.js";
import { OXLINT_PROFILE } from "./oxlint-input.js";
import type { LintDiagnostic, OxlintResult } from "./oxlint-result.js";

/** Reads a file as a commit or tree holds it. */
export type ContentReader = (revision: string, path: string) => string | undefined;

const lintable = /\.(ts|js)$/u;
const limits = "Static rules only: unused variables, debugger statements, constant conditions, unsafe optional " +
  "chaining, missing throw, explicit any, TypeScript suppression comments, non-null assertions and accumulating " +
  "spreads. The code is parsed, never run.";

/** Lint one file's content in a private directory, never in the checkout. Oxlint runs under Tesota's own Bun. */
async function lint(content: string, name: string, executable: string): Promise<OxlintResult> {
  const directory = await mkdtemp(join(tmpdir(), "tesota-lint-"));
  try {
    await writeFile(join(directory, name), content, { mode: 0o600 });
    return await runOxlint(configuredOxlint(directory, executable), name);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function diagnosticKey(diagnostic: LintDiagnostic): string { return `${diagnostic.rule}\u0000${diagnostic.message}`; }

/** Diagnostics the change introduced: those the base version did not already have, counted by rule and message. */
export function introducedDiagnostics(candidate: readonly LintDiagnostic[], base: readonly LintDiagnostic[]): LintDiagnostic[] {
  const remaining = new Map<string, number>();
  for (const diagnostic of base) remaining.set(diagnosticKey(diagnostic), (remaining.get(diagnosticKey(diagnostic)) ?? 0) + 1);
  return candidate.filter((diagnostic) => {
    const count = remaining.get(diagnosticKey(diagnostic)) ?? 0;
    if (count === 0) return true;
    remaining.set(diagnosticKey(diagnostic), count - 1);
    return false;
  });
}

type Verdict = Pick<CheckResult, "outcome" | "output">;

/** The outcome for one file, judged against its base version so earlier problems do not count against the change. */
export function oxlintVerdict(candidate: OxlintResult, base: OxlintResult | undefined): Verdict {
  if (candidate.status === "execution_failed") {
    if (candidate.reason !== "inline_suppression") return { outcome: "not_started", output: `Oxlint did not run: ${candidate.reason}` };
    if (base?.status === "execution_failed" && base.reason === "inline_suppression") {
      return { outcome: "not_started", output: "The file already carried an inline lint suppression, so the profile cannot check it." };
    }
    return { outcome: "failed", output: "The change adds an inline lint suppression (eslint-disable or oxlint-disable)." };
  }
  const earlier = base !== undefined && base.status !== "execution_failed" ? base.diagnostics : [];
  const introduced = introducedDiagnostics(candidate.diagnostics, earlier);
  const kept = candidate.diagnostics.length - introduced.length;
  const note = kept === 0 ? "" : `${kept} ${kept === 1 ? "diagnostic" : "diagnostics"} existed before this change and do not count.`;
  if (introduced.length === 0) return { outcome: "passed", output: note };
  return { outcome: "failed", output: [...introduced.map((diagnostic) =>
    `${diagnostic.line}:${diagnostic.column} ${diagnostic.rule}: ${diagnostic.message}`), note].filter((line) => line.length > 0).join("\n") };
}

/**
 * Tesota's fixed Oxlint profile on the candidate's added and modified
 * JavaScript and TypeScript files, read from the frozen tree. It runs on this
 * computer because it only parses the files.
 */
export async function runOxlintVerifier(snapshot: WorkspaceSnapshot, read: ContentReader,
  executable: string = process.execPath): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const change of snapshot.changes) {
    if (change.status === "deleted" || !lintable.test(change.path)) continue;
    const content = read(snapshot.tree, change.path);
    if (content === undefined) continue;
    const started = Date.now();
    const earlier = change.status === "modified" ? read(snapshot.base, change.path) : undefined;
    const verdict = oxlintVerdict(await lint(content, basename(change.path), executable),
      earlier === undefined ? undefined : await lint(earlier, basename(change.path), executable));
    results.push({ verifier: "oxlint", command: `oxlint ${change.path}`, tree: snapshot.tree,
      claim: `Tesota's Oxlint profile (${OXLINT_PROFILE}) finds nothing in ${change.path} that its base version did not have`,
      limits, environment: "host", guarantees: hostProvider.guarantees, outcome: verdict.outcome,
      exitCode: null, durationMs: Date.now() - started, output: verdict.output });
  }
  return results;
}
