import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TObject, type TString, Type } from "typebox";
import type { Evidence } from "./evidence.js";
import { annotations, proveFile } from "./verification/lemmascript-verifier.js";

/**
 * The working agent's own proof run (#294): LemmaScript with Dafny on one
 * TypeScript file it is working on, so it sees a failing obligation while it
 * works, as LemmaScript's loop intends, instead of after the turn.
 */

/**
 * LemmaScript's annotation syntax, from its specification (docs.lemmascript.org/spec): GPT-6 Luna, asked to
 * strengthen a contract with a quantifier, wrote `forall (i: number, …)` and `\\forall i :: …`, which LemmaScript
 * rejects, so the proof never ran.
 */
const syntaxGuidance = "LemmaScript syntax: //@ requires P and //@ ensures P above the function, with \\result for " +
  "its return value; //@ invariant P as the first lines inside a loop; forall(j: nat, j < items.length ==> P) and " +
  "exists(j: nat, j < items.length && P); ==> for implication and === for equality.";

/** How the agent should use `prove`, and what a pass is worth: #294's measured guidance. */
export const PROVE_GUIDELINES: readonly string[] = [
  "prove runs LemmaScript with Dafny on a TypeScript file with //@ annotations and reports whether its contracts " +
    "hold for every input they admit. After you change such a file, run prove and work until it passes.",
  "A failure points at an obligation: the code may be wrong, or the proof may need a loop invariant or an assertion.",
  syntaxGuidance,
  "Change a contract only when the request asks for different behavior, and say so in your summary; never remove or " +
    "loosen a contract, or add //@ assume, to make a proof pass. If you cannot make it pass, say which obligation still fails.",
];

/**
 * What follows a failed proof, at the moment the agent reads it: in the first
 * measurement GPT-6 Luna stopped after one failure in 2 of 5 runs of a proof
 * it could finish, where the prompt's guidance was read long before.
 */
const retryNote = "This is not finished yet. Read the obligation that failed above, then change the code or add the " +
  "//@ invariant or assertion it needs, and run prove again. Keep going until it passes; stop only if you can say " +
  "why it cannot pass without changing the contract, and never loosen the contract to make it pass.";

/**
 * What follows a vacuous proof: LemmaScript attaches a `//@` block only to
 * the function right below it, so anything between them drops its contracts.
 */
const vacuousNote = "Check that every //@ requires and //@ ensures block sits directly above the function it " +
  "describes: anything between the //@ block and the function drops its contracts. Fix that and run prove again.";

const skippedFolders = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);
const scanLimit = 20_000;
const fileLimit = 1024 * 1024;

/**
 * Whether the project has a TypeScript file with `//@` annotations, which
 * turns on `prove` and its guidance (#294). It walks at most `scanLimit`
 * entries, skipping dependency, build and hidden folders, and reads only
 * TypeScript files under a megabyte; a project it cannot read has none.
 */
export function hasContracts(root: string): boolean {
  const folders = [root];
  let seen = 0;
  while (folders.length > 0 && seen < scanLimit) {
    const folder = folders.pop() ?? root;
    let entries: Dirent[];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!skippedFolders.has(entry.name) && !entry.name.startsWith(".")) folders.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        try {
          if (statSync(path).size <= fileLimit && annotations(readFileSync(path, "utf8")).length > 0) return true;
        } catch { /* An unreadable file has no annotations Tesota could prove. */ }
      }
    }
  }
  return false;
}

/** A proof's result for the agent, from `prove` or the gate: how it ended, what LemmaScript printed and what to do next. */
export function proofReport(path: string, proof: Evidence): string {
  const how = proof.outcome === "passed" ? `Proved: every //@ contract in ${path} holds.`
    : proof.outcome === "failed" ? `Not proved: an obligation in ${path} failed.`
    : proof.outcome === "timed_out" ? `The proof of ${path} ran past its time limit; that is not a pass.`
    : proof.outcome === "cancelled" ? `The proof of ${path} was stopped.`
    : proof.outcome === "vacuous" ? `Not proved: Dafny verified nothing in ${path}, so none of its contracts was proved.`
    : `Not proved: the proof of ${path} could not run.`;
  const next = proof.outcome === "failed" ? `\n\n${retryNote}` : proof.outcome === "vacuous" ? `\n\n${vacuousNote}` : "";
  return `${how}\n\n${proof.output}${next}`;
}

function text(content: string): { content: { type: "text"; text: string }[]; details: undefined } {
  return { content: [{ type: "text", text: content }], details: undefined };
}

const parameters: TObject<{ path: TString }> = Type.Object({ path: Type.String({ description: "The TypeScript file to prove, relative to the project" }) });

/**
 * `prove`, inactive until the extension finds contracts (`hasContracts`). It
 * runs alone, since the evidence must describe the files as no other tool
 * call left them mid-proof.
 */
export const proveTool: ToolDefinition<typeof parameters> = {
  name: "prove", label: "Prove",
  description: "Run LemmaScript with Dafny on one TypeScript file with //@ annotations and report whether its " +
    "contracts are proved. It first regenerates the file's .dfy proof, keeping the proof lines you added, as " +
    "lsc regen does.",
  promptSnippet: "Prove a TypeScript file's //@ LemmaScript contracts with Dafny",
  promptGuidelines: [...PROVE_GUIDELINES],
  parameters,
  defaultActive: false,
  executionMode: "sequential",
  execute: async (_id, params, signal, _update, ctx) => {
    const absolute = resolve(ctx.cwd, params.path.replace(/^@/u, ""));
    const path = relative(ctx.cwd, absolute).split("\\").join("/");
    if (path === "" || path.startsWith("../") || isAbsolute(path)) {
      return text(`${params.path} is outside the project; prove checks files inside it.`);
    }
    if (!path.endsWith(".ts")) return text(`${path} is not a TypeScript file; prove checks .ts files with //@ annotations.`);
    let source: string;
    try { source = await readFile(absolute, "utf8"); } catch { return text(`${path} does not exist.`); }
    if (annotations(source).length === 0) return text(`${path} has no //@ annotations, so there is nothing to prove.`);
    return text(proofReport(path, await proveFile(ctx.cwd, path, signal ?? new AbortController().signal)));
  },
};
