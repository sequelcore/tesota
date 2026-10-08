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

/** The SHA-256 of files' paths and content, in order; an unreadable file counts as absent. */
export function contentHash(files: readonly { readonly path: string; readonly content: string | undefined }[]): string {
  return createHash("sha256").update(JSON.stringify(files.map((file) => [file.path, file.content ?? null]))).digest("hex");
}
