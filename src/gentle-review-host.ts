import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { inspectCandidateCheckout } from "./candidate-checkout.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { runPiCodingAgent } from "./integrations/pi-coding-agent.js";

export const GENTLE_REVIEW_LENSES = ["risk", "resilience", "readability", "reliability"] as const;
const resultSchema = z.strictObject({ summary: z.string().min(1).max(8_000), findings: z.array(z.strictObject({
  severity: z.enum(["info", "low", "medium", "high"]), path: z.string().min(1).max(512), description: z.string().min(1).max(4_000),
})).max(32) });
export type GentleReviewLens = "risk" | "resilience" | "readability" | "reliability";
export interface GentleReviewResult { readonly summary: string; readonly findings: readonly { readonly severity: "info" | "low" | "medium" | "high"; readonly path: string; readonly description: string }[]; }

function parseModelResult(text: string): GentleReviewResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Reviewer returned no JSON result");
  return resultSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** Runs one read-only Gentle review role through Pi with Tesota's Codex OAuth store. */
export async function runGentleReviewHost(options: {
  readonly candidate: string;
  readonly lens: GentleReviewLens;
  readonly credentials?: CodexCredentials;
}): Promise<{ readonly format: "tesota-gentle-review"; readonly version: 1; readonly lens: GentleReviewLens; readonly candidateIdentity: string; readonly status: "completed" | "failed" | "timed_out"; readonly result?: GentleReviewResult; readonly error?: string }> {
  const candidate = await inspectCandidateCheckout(options.candidate);
  const candidateIdentity = createHash("sha256").update(JSON.stringify({ baseline: candidate.baseline, head: candidate.head, changes: candidate.changes })).digest("hex");
  const prompt = `Review this frozen candidate using the ${options.lens} lens. Use only the read tool. Return only JSON matching {"summary":"...","findings":[{"severity":"info|low|medium|high","path":"repository-relative path","description":"..."}]}. Do not edit files, run commands, or claim that a finding is verified beyond the visible candidate.`;
  const credentials = options.credentials ?? new CodexCredentials();
  let run = await runPiCodingAgent({ cwd: candidate.checkout, prompt, credentials, tools: ["read"] });
  if (run.status !== "completed") return { format: "tesota-gentle-review", version: 1, lens: options.lens, candidateIdentity, status: run.status, ...(run.error === undefined ? {} : { error: run.error }) };
  try { return { format: "tesota-gentle-review", version: 1, lens: options.lens, candidateIdentity, status: "completed", result: parseModelResult(run.responseText) }; }
  catch (firstError) {
    run = await runPiCodingAgent({ cwd: candidate.checkout,
      prompt: `${prompt}\nYour prior response was not usable. Reply now with the JSON object, even when findings is empty.`, credentials, tools: ["read"] });
    if (run.status !== "completed") return { format: "tesota-gentle-review", version: 1, lens: options.lens, candidateIdentity, status: run.status, ...(run.error === undefined ? {} : { error: run.error }) };
    try { return { format: "tesota-gentle-review", version: 1, lens: options.lens, candidateIdentity, status: "completed", result: parseModelResult(run.responseText) }; }
    catch (error) { return { format: "tesota-gentle-review", version: 1, lens: options.lens, candidateIdentity, status: "failed", error: error instanceof Error ? error.message : firstError instanceof Error ? firstError.message : String(firstError) }; }
  }
}

/** Persist one bounded reviewer result as evidence; it never changes candidate bytes. */
export async function saveGentleReviewResult(candidate: string, result: Awaited<ReturnType<typeof runGentleReviewHost>>): Promise<void> {
  const file = await open(join((await inspectCandidateCheckout(candidate)).directory, `gentle-review-${result.lens}.json`), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(result, null, 2) + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
}
