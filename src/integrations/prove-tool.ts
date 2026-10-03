import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { annotations, dafnyInstalled, proveSource } from "../verification/lemmascript-verifier.js";

/**
 * The working agent's own proof run (#294): LemmaScript with Dafny on one
 * TypeScript file it is working on, so it sees a failing obligation while it
 * works, as LemmaScript's loop intends, instead of after the turn. What it
 * returns is feedback to the agent; Tesota's run on the candidate after the
 * turn remains the evidence. The caller confines `path` to the workspace and
 * refuses hidden files.
 */

/** What changing a file with `//@` contracts asks of the agent, with or without `prove`. */
/**
 * LemmaScript's annotation syntax, from its specification (docs.lemmascript.org/spec): GPT-6 Luna, asked to
 * strengthen a contract with a quantifier, wrote `forall (i: number, …)` and `\\forall i :: …`, which LemmaScript
 * rejects, so the proof never ran.
 */
const syntaxGuidance = "LemmaScript syntax: //@ requires P and //@ ensures P above the function, with \\result for " +
  "its return value; //@ invariant P as the first lines inside a loop; forall(j: nat, j < items.length ==> P) and " +
  "exists(j: nat, j < items.length && P); ==> for implication and === for equality. ";
const contractGuidance = syntaxGuidance + "Change a contract only when the request asks for different behavior, and say " +
  "so in your summary; never remove or loosen a contract, or add //@ assume, to make a proof pass. ";

/**
 * The contract guidance alone, without the tool, so a measurement can tell
 * the tool's effect from the guidance's.
 */
export const CONTRACT_GUIDANCE: string = "TypeScript files with //@ annotations carry LemmaScript contracts, which " +
  "Tesota proves with Dafny after your turn. When you change such a file, keep its contracts provable: the code must " +
  "meet them, and a loop needs //@ invariant lines strong enough to prove them. " + contractGuidance;

/** How the agent should use `prove`, and what a pass is worth. */
export const PROVE_GUIDANCE: string = "prove runs LemmaScript with Dafny on a TypeScript file with //@ annotations and " +
  "reports whether its contracts hold for every input they admit. After you change such a file, run prove and " +
  "work until it passes. A failure points at an obligation: the code may be wrong, or the proof may need a loop " +
  "invariant or an assertion. " + contractGuidance + "If you cannot make it pass, say which obligation still fails. ";

const skippedFolders = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".tesota"]);
const scanLimit = 20_000;
const fileLimit = 1024 * 1024;

/**
 * Whether the repository has a TypeScript file with `//@` annotations, which
 * turns on `prove` and its guidance (#294). It walks at most `scanLimit`
 * entries, skipping dependency, build and hidden folders, and reads only
 * TypeScript files under a megabyte; a repository it cannot read has none.
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

/**
 * What follows a failed proof, at the moment the agent reads it: in the first
 * measurement GPT-6 Luna stopped after one failure in 2 of 5 runs of a proof
 * it could finish, where the prompt's guidance was read long before.
 */
const retryNote = "This is not finished yet. Read the obligation that failed above, then change the code or add the " +
  "//@ invariant or assertion it needs, and run prove again. Keep going until it passes; stop only if you can say " +
  "why it cannot pass without changing the contract, and never loosen the contract to make it pass.";

function text(content: string): { content: { type: "text"; text: string }[]; details: undefined } {
  return { content: [{ type: "text", text: content }], details: undefined };
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

export function proveTool(root: string): ToolDefinition {
  return defineTool({
    name: "prove", label: "Prove",
    description: "Run LemmaScript with Dafny on one TypeScript file with //@ annotations, with its .dfy companion when " +
      "it has one, and report whether its contracts are proved. Your files are not changed.",
    parameters: Type.Object({ path: Type.String({ description: "The TypeScript file to prove, relative to the workspace" }) }),
    execute: async (_id, params, signal) => {
      const path = resolve(root, params.path.replace(/^@/u, ""));
      const name = relative(root, path).split("\\").join("/") || basename(path);
      if (!path.endsWith(".ts")) return text(`${name} is not a TypeScript file; prove checks .ts files with //@ annotations.`);
      const source = await readIfPresent(path);
      if (source === undefined) return text(`${name} does not exist.`);
      if (annotations(source).length === 0) return text(`${name} has no //@ annotations, so there is nothing to prove.`);
      const stop = signal ?? new AbortController().signal;
      if (!await dafnyInstalled(stop)) return text("Dafny is not installed on this computer, so nothing can be proved.");
      const proof = await proveSource(basename(path), source, await readIfPresent(path.replace(/\.ts$/u, ".dfy")), stop);
      const how = proof.outcome === "passed" ? `Proved: every //@ contract in ${name} holds.`
        : proof.outcome === "failed" ? `Not proved: an obligation in ${name} failed.`
        : proof.outcome === "timed_out" ? `The proof of ${name} ran past its time limit; that is not a pass.`
        : proof.outcome === "cancelled" ? `The proof of ${name} was stopped.`
        : `The proof of ${name} could not start.`;
      return text(`${how}\n\n${proof.output.trimEnd()}${proof.outcome === "failed" ? `\n\n${retryNote}` : ""}`);
    },
  });
}
