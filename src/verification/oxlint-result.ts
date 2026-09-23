import { resolve } from "node:path";
import { OXLINT_DIAGNOSTIC_RULES, OXLINT_PROFILE, isKnownDiagnosticRule,
  type InputBinding, type OxlintProfile } from "./oxlint-input.js";

export interface LintDiagnostic {
  readonly rule: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export type OxlintReport =
  | {
      readonly status: "passed" | "check_failed";
      readonly file: string;
      readonly profile: OxlintProfile;
      readonly diagnostics: readonly LintDiagnostic[];
      readonly process: "exited";
    }
  | {
      readonly status: "execution_failed";
      readonly reason: string;
      readonly process: "not_started" | "exited" | "unconfirmed";
      readonly pid?: number;
      readonly retainedDirectory?: string;
    };

export type CompletedOxlintReport = Exclude<OxlintReport, { readonly status: "execution_failed" }>;

export type OxlintResult =
  | (CompletedOxlintReport & { readonly binding: InputBinding })
  | (Extract<OxlintReport, { readonly status: "execution_failed" }> & { readonly binding?: InputBinding });

export type CompletedOxlintResult = CompletedOxlintReport & { readonly binding: InputBinding };

export interface RecoveredOxlintEvidence {
  readonly kind: "recovered";
  readonly structuralValidity: "valid";
  readonly provenance: "recovered_untrusted";
  readonly historical: CompletedOxlintResult;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reportDiagnostics(value: unknown): readonly unknown[] | undefined {
  if (!record(value)) return undefined;
  if (value["number_of_files"] !== 1) return undefined;
  if (value["number_of_rules"] !== OXLINT_DIAGNOSTIC_RULES.length) return undefined;
  if (value["threads_count"] !== 1) return undefined;
  const startTime = value["start_time"];
  if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime < 0) return undefined;
  return Array.isArray(value["diagnostics"]) ? value["diagnostics"] : undefined;
}

function diagnosticLocation(value: unknown): { readonly line: number; readonly column: number } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const label: unknown = value[0];
  if (!record(label) || !record(label["span"])) return undefined;
  const line = label["span"]["line"];
  const column = label["span"]["column"];
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return undefined;
  if (typeof column !== "number" || !Number.isSafeInteger(column) || column < 1) return undefined;
  return { line, column };
}

function lintDiagnostic(value: unknown, file: string, cwd: string): LintDiagnostic | undefined {
  if (!record(value)) return undefined;
  const rule = value["code"];
  if (!isKnownDiagnosticRule(rule)) return undefined;
  if (value["severity"] !== "error") return undefined;
  const message = value["message"];
  if (typeof message !== "string" || message.length === 0) return undefined;
  const filename = value["filename"];
  if (typeof filename !== "string" || resolve(cwd, filename) !== file) return undefined;
  const location = diagnosticLocation(value["labels"]);
  return location === undefined ? undefined : { rule, message, ...location };
}

/** Project only the pinned producer's fields needed by the fixed profile. */
export function interpretOxlint(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  file: string,
  cwd: string = process.cwd(),
): OxlintReport {
  const invalid: OxlintReport = {
    status: "execution_failed", reason: "invalid_verifier_result", process: "exited",
  };
  if (stderr.trim() !== "" || (exitCode !== 0 && exitCode !== 1)) return invalid;
  let report: unknown;
  try { report = JSON.parse(stdout); } catch { return invalid; }
  const reportedDiagnostics = reportDiagnostics(report);
  if (reportedDiagnostics === undefined) return invalid;

  const diagnostics: LintDiagnostic[] = [];
  for (const value of reportedDiagnostics) {
    const diagnostic = lintDiagnostic(value, file, cwd);
    if (diagnostic === undefined) return invalid;
    diagnostics.push(diagnostic);
  }
  if (exitCode !== (diagnostics.length === 0 ? 0 : 1)) return invalid;
  return {
    status: diagnostics.length === 0 ? "passed" : "check_failed",
    profile: OXLINT_PROFILE, file, diagnostics, process: "exited",
  };
}
