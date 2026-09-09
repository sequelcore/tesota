import { resolve } from "node:path";
import type { InputBinding } from "./oxlint-input.js";

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
      readonly profile: "oxlint-basic/v1";
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

export type OxlintResult =
  | (Exclude<OxlintReport, { readonly status: "execution_failed" }> & { readonly binding: InputBinding })
  | (Extract<OxlintReport, { readonly status: "execution_failed" }> & { readonly binding?: InputBinding });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!record(report) || report["number_of_files"] !== 1 ||
      report["number_of_rules"] !== 2 || report["threads_count"] !== 1 ||
      typeof report["start_time"] !== "number" ||
      !Number.isFinite(report["start_time"]) || report["start_time"] < 0 ||
      !Array.isArray(report["diagnostics"])) return invalid;

  const diagnostics: LintDiagnostic[] = [];
  for (const value of report["diagnostics"]) {
    if (!record(value) ||
        (value["code"] !== "eslint(no-debugger)" && value["code"] !== "eslint(no-unused-vars)") ||
        value["severity"] !== "error" || typeof value["message"] !== "string" ||
        value["message"].length === 0 || typeof value["filename"] !== "string" ||
        resolve(cwd, value["filename"]) !== file || !Array.isArray(value["labels"]) ||
        value["labels"].length === 0) return invalid;
    const label: unknown = value["labels"][0];
    if (!record(label) || !record(label["span"])) return invalid;
    const line = label["span"]["line"];
    const column = label["span"]["column"];
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 ||
        typeof column !== "number" || !Number.isSafeInteger(column) || column < 1) return invalid;
    diagnostics.push({ rule: value["code"], message: value["message"], line, column });
  }
  if (exitCode !== (diagnostics.length === 0 ? 0 : 1)) return invalid;
  return {
    status: diagnostics.length === 0 ? "passed" : "check_failed",
    profile: "oxlint-basic/v1", file, diagnostics, process: "exited",
  };
}
