import { createHash } from "node:crypto";
import type { ProofOutcome } from "./verification/proof-outcome-rule.js";

/**
 * What one verifier run checked, how it ended and what it printed, bound to
 * the content it checked: evidence describes the files only while their
 * content still has `contentHash`.
 */
export interface Evidence {
  /** `command` for a project command, such as its tests, run on the changed files. */
  readonly verifier: "lemmascript" | "command";
  /** What a pass establishes, in words a reviewer can confirm. */
  readonly claim: string;
  /** What a pass does not establish. */
  readonly limits: string;
  readonly outcome: ProofOutcome;
  /** The end of what the verifier printed, or why it did not run. */
  readonly output: string;
  readonly durationMs: number;
  /** The files the run checked, relative to the project root, in the order `contentHash` covers them. */
  readonly files: readonly string[];
  readonly contentHash: string;
}

/**
 * A proof's run in a few words for people: how it ended, Dafny's first error
 * and the contract line it points at, and Dafny's tally. Dafny prints CRLF
 * on Windows.
 */
export function proofSummary(evidence: Evidence): { readonly words: string; readonly at?: string; readonly tally?: string } {
  const tally = /finished with (\d+ verified, \d+ errors?)/u.exec(evidence.output)?.[1];
  const counted = tally === undefined ? {} : { tally };
  if (evidence.outcome === "passed") return { words: "every contract holds", ...counted };
  if (evidence.outcome === "vacuous") return { words: "Dafny verified nothing, so no contract was proved", ...counted };
  if (evidence.outcome === "timed_out") return { words: "the proof ran past its time limit" };
  if (evidence.outcome === "cancelled") return { words: "the proof was stopped" };
  if (evidence.outcome === "not_started") return { words: `the proof could not run: ${evidence.output.trim().split(/\r?\n/u).at(-1) ?? ""}` };
  const error = /Error: ([^\r\n]+)/u.exec(evidence.output)?.[1]?.trim();
  const at = /Related location[^\r\n]*\r?\n[^\r\n]*\r?\n\s*\d+\s*\|\s*([^\r\n]+)/u.exec(evidence.output)?.[1]?.trim();
  return { words: error ?? "an obligation fails", ...at === undefined ? {} : { at }, ...counted };
}

/** What a verifier printed, without the lines that only report its own steps, such as where it wrote a file. */
export function quietOutput(output: string): string[] {
  return output.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => !/^(?:Generated|Created): |^Running dafny verify/u.test(line))
    .filter((line, k, all) => line !== "" || (k > 0 && all[k - 1] !== ""));
}

/** The SHA-256 of files' paths and content, in order; an unreadable file counts as absent. */
export function contentHash(files: readonly { readonly path: string; readonly content: string | undefined }[]): string {
  return createHash("sha256").update(JSON.stringify(files.map((file) => [file.path, file.content ?? null]))).digest("hex");
}
