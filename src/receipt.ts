import type { Evidence } from "./evidence.js";
import type { GateVerdict } from "./verification/gate-rule.js";

/**
 * What a run that changed files leaves the operator when it settles: each
 * changed file with contracts, the gate's verdict on its proof and the
 * evidence, bound to the content it checked; and the changed files nothing
 * verified. Version 0 covers proofs only.
 */
export interface Receipt {
  readonly version: 0;
  /** False when the project has no Git repository, so nothing could tell which files changed or verify them. */
  readonly repository: boolean;
  readonly proofs: readonly { readonly path: string; readonly verdict: GateVerdict; readonly evidence: Evidence }[];
  /** Changed files, relative to the project, that no evidence covers. */
  readonly unverified: readonly string[];
}

function line(path: string, verdict: GateVerdict, evidence: Evidence): string {
  if (verdict === "proved") return `  proved        ${path}`;
  if (verdict === "operator") {
    const why = evidence.outcome === "timed_out" ? "ran past its time limit" : evidence.outcome === "cancelled"
      ? "was stopped" : `could not run: ${evidence.output.split("\n").at(-1) ?? ""}`;
    return `  NOT proved    ${path}: the proof ${why}`;
  }
  const what = evidence.outcome === "vacuous" ? "Dafny verified nothing" : "an obligation fails";
  return `  NOT proved    ${path}: ${what}, repeating a failure already sent back`;
}

/** The receipt as the operator reads it; `details` of its session entry carries the receipt itself. */
export function renderReceipt(receipt: Receipt): string {
  if (!receipt.repository) {
    return "Tesota receipt\n  not verified  this request's changes: the project has no Git repository, so Tesota " +
      "cannot tell which files changed";
  }
  return [
    "Tesota receipt",
    ...receipt.proofs.flatMap(({ path, verdict, evidence }) =>
      [line(path, verdict, evidence), `                content sha256 ${evidence.contentHash}`]),
    ...receipt.unverified.map((path) => `  not verified  ${path}: no verifier covers it`),
  ].join("\n");
}
