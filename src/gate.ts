import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Evidence } from "./evidence.js";
import { proofReport } from "./prove-tool.js";
import { type Receipt, renderReceipt } from "./receipt.js";
import { gateVerdict, keepsWorking } from "./verification/gate-rule.js";
import { annotations, proveFile } from "./verification/lemmascript-verifier.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [...args, "-z"], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\0").filter((path) => path !== "");
  } catch { return undefined; }
}

/**
 * The files under `root` that differ from `HEAD` or are untracked, relative
 * to it; every tracked file in a repository with no commit yet. Deleted files
 * are left out, and so is everything outside a Git repository (`undefined`).
 */
export async function changedFiles(root: string): Promise<string[] | undefined> {
  const tracked = await git(root, ["diff", "--name-only", "--relative", "--diff-filter=d", "HEAD"])
    ?? await git(root, ["ls-files", "--cached"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  return tracked === undefined || untracked === undefined ? undefined : [...new Set([...tracked, ...untracked])].sort();
}

async function hasAnnotations(root: string, path: string): Promise<boolean> {
  try { return annotations(await readFile(join(root, path), "utf8")).length > 0; } catch { return false; }
}

/**
 * The changed TypeScript files with `//@` contracts, and those whose `.dfy`
 * proof changed, since a proof's hand-written lines are part of what it proves.
 */
async function contractFiles(root: string, changed: readonly string[]): Promise<string[]> {
  const sources = new Set(changed.map((path) => path.replace(/\.dfy(\.gen)?$/u, ".ts")).filter((path) =>
    path.endsWith(".ts") && !path.endsWith(".d.ts")));
  const files: string[] = [];
  for (const path of [...sources].sort()) if (await hasAnnotations(root, path)) files.push(path);
  return files;
}

/** Built-in tools that only read, and `prove`, whose changes are the proof's own; any other tool may change files. */
const readOnlyTools = new Set(["read", "grep", "find", "ls", "prove"]);

/**
 * The gate (#339): before a completed run settles, it proves every changed
 * file with contracts. A failed or vacuous proof goes back to the agent and
 * the run continues, until the agent repeats any failure the gate already
 * sent back for that file (`gateVerdict`). That memory lasts for the
 * operator's request: it resets on their input, not on `agent_start`, which
 * every continuation fires too. When nothing goes back, the run settles with
 * a receipt for the operator. Outside a Git repository it cannot tell what
 * changed, so a request that ran a tool that may change files ends with a
 * receipt that says so.
 */
export function registerGate(pi: ExtensionAPI): void {
  let sentBack = new Map<string, string[]>();
  let mayHaveChanged = false;
  pi.on("input", (event) => {
    if (event.source !== "extension") { sentBack = new Map(); mayHaveChanged = false; }
    return undefined;
  });
  pi.on("tool_execution_start", (event) => { if (!readOnlyTools.has(event.toolName)) mayHaveChanged = true; });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return undefined;
    const changed = await changedFiles(ctx.cwd);
    if (changed === undefined) {
      if (!mayHaveChanged) return undefined;
      const receipt: Receipt = { version: 0, repository: false, proofs: [], unverified: [] };
      return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
        display: true, details: receipt }] };
    }
    if (changed.length === 0) return undefined;
    const signal = ctx.signal ?? new AbortController().signal;
    const failure = (proof: Evidence): string => `${proof.outcome}\n${proof.output}`;
    const judged: Receipt["proofs"][number][] = [];
    for (const path of await contractFiles(ctx.cwd, changed)) {
      const evidence = await proveFile(ctx.cwd, path, signal);
      judged.push({ path, verdict: gateVerdict(evidence.outcome, failure(evidence), sentBack.get(path) ?? []), evidence });
    }
    if (keepsWorking(judged.map(({ verdict }) => verdict))) {
      const back = judged.filter(({ verdict }) => verdict === "send_back");
      for (const { path, evidence } of back) sentBack.set(path, [...sentBack.get(path) ?? [], failure(evidence)]);
      const proveActive = pi.getActiveTools().includes("prove");
      const content = back.map(({ path, evidence }) =>
        `Tesota: ${path} does not prove yet.\n\n${proofReport(path, evidence, proveActive)}`).join("\n\n");
      return { entries: [{ type: "custom_message", customType: "tesota-gate", content, display: true }], continue: true };
    }
    // A proof's `.dfy.gen` is the base `lsc regen` merges against, regenerated from the source the proof covers.
    const covered = new Set(judged.flatMap(({ evidence }) => evidence.files.flatMap((path) =>
      path.endsWith(".dfy") ? [path, `${path}.gen`] : [path])));
    const receipt: Receipt = { version: 0, repository: true, proofs: judged, unverified: changed.filter((path) => !covered.has(path)) };
    return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
      display: true, details: receipt }] };
  });
}
