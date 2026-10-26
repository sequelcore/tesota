import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Theme, ToolDefinition, ToolResult } from "./contract.js";
import { type TObject, type TString, Type } from "typebox";
import { type Evidence, proofSummary, quietOutput } from "./evidence.js";
import { bold, expandHint, Rows, spread, wrapUnder } from "./messages.js";
import { skippedWords, trustedWords } from "./receipt.js";
import type { OnTrust } from "./verification-changes.js";
import { annotations, projectFiles, proveFile, unreadSpecifications } from "./verification/lemmascript-verifier.js";

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
const retryNote = (again: string): string => "This is not finished yet. Read the obligation that failed above, then " +
  `change the code or add the //@ invariant or assertion it needs, and ${again}. Keep going until it passes; stop only ` +
  "if you can say why it cannot pass without changing the contract, and never loosen the contract to make it pass.";

/**
 * What follows a vacuous proof: LemmaScript reads a function's annotations
 * above it, across comments and blank lines, and before the first statement
 * of its body (`contracts`); code in between drops them, and an arrow function
 * with a block body has them read only inside the body.
 */
const vacuousNote = (again: string): string => "Check where each //@ requires and //@ ensures sits: above the function " +
  "it describes, with only comments or blank lines between, or before the first statement in its body. A line of code " +
  "between them and the function drops them, and an arrow function with a { } body reads them only inside the body. " +
  `Fix that and ${again}.`;

const fileLimit = 1024 * 1024;

/**
 * Whether the project has a TypeScript file with `//@` annotations, which
 * turns on `prove` and its guidance (#294). It reads only the project's
 * files `projectFiles` walks to (`annotated`); a project it cannot read has
 * none.
 */
export function hasContracts(root: string): boolean {
  for (const file of projectFiles(root)) {
    if (annotated(join(root, file))) return true;
  }
  return false;
}

/** Whether `path` is a TypeScript file under a megabyte with `//@` annotations; a file Tesota cannot read has none. */
export function annotated(path: string): boolean {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return false;
  try {
    return statSync(path).size <= fileLimit && annotations(readFileSync(path, "utf8")).length > 0;
  } catch { return false; }
}

/** What a proof takes on trust or leaves out (`provedOnTrust`), in the receipt's plain words, with the line as written. */
function trustLine(change: OnTrust): string {
  return `- ${change.path}: ${change.kind === "added_skip" ? skippedWords(change) : trustedWords(change)} (${change.annotation})`;
}

/**
 * A pass, in words that claim no more than the proof: every contract holds
 * only when the files it checked trust nothing and leave nothing out (#402);
 * otherwise each such line is named, as the receipt names them (#399).
 */
function passedWords(path: string, trusted: readonly OnTrust[]): string {
  if (trusted.length === 0) return `Proved: every //@ contract in ${path} holds.`;
  return `Proved, but not outright: the //@ contracts in ${path} hold only if what it trusts is right, and nothing ` +
    `proves what it leaves out:\n${trusted.map(trustLine).join("\n")}\nSay so in your summary.`;
}

/** What the files a proof checked take on trust or leave out (`provedOnTrust`), read as the proof left them. */
async function trustedIn(root: string, files: readonly string[]): Promise<OnTrust[]> {
  const read = async (path: string): Promise<string | undefined> => {
    try { return await readFile(join(root, path), "utf8"); } catch { return undefined; }
  };
  const found = await Promise.all(files.map(async (path) => ({ path, content: await read(path),
    generated: path.endsWith(".dfy") ? await read(`${path}.gen`) : undefined })));
  // Loaded when a proof first passes rather than with Tesota, as the gate loads its checks (#446).
  const { provedOnTrust } = await import("./verification-changes.js");
  return provedOnTrust(found.flatMap(({ path, content, generated }) => content === undefined ? []
    : [{ path, content, ...generated === undefined ? {} : { generated } }]));
}

/**
 * A proof's result for the agent, from `prove` or the gate: how it ended,
 * what LemmaScript printed and what to do next, which names `prove` only
 * when the agent has it (`proveActive`); otherwise the gate proves again.
 */
export function proofReport(path: string, proof: Evidence, proveActive: boolean, trusted: readonly OnTrust[] = [],
  unread: readonly { line: number; text: string }[] = []): string {
  const again = proveActive ? "run prove again" : "finish your turn, and Tesota will prove the file again";
  const skipped = unread.length === 0 ? "" : `\n\nLemmaScript skips these //@ lines without a word, so the proof checked ` +
    `none of them:\n${unread.map(({ line, text: written }) => `- line ${line}: ${written}`).join("\n")}\nWrite each as ` +
    `//@ <keyword> <expression>, with one space after //@ and one after the keyword, and ${again}.`;
  const how = proof.outcome === "passed" && unread.length > 0 ? `Proved, but not all of ${path}: LemmaScript skipped some of its //@ lines.`
    : proof.outcome === "passed" ? passedWords(path, trusted)
    : proof.outcome === "failed" ? `Not proved: an obligation in ${path} failed.`
    : proof.outcome === "timed_out" ? `The proof of ${path} ran past its time limit; that is not a pass.`
    : proof.outcome === "cancelled" ? `The proof of ${path} was stopped.`
    : proof.outcome === "vacuous" ? `Not proved: Dafny verified nothing in ${path}, so none of its contracts was proved.`
    : `Not proved: the proof of ${path} could not run.`;
  const next = proof.outcome === "failed" ? `\n\n${retryNote(again)}` : proof.outcome === "vacuous" ? `\n\n${vacuousNote(again)}` : "";
  return `${how}\n\n${proof.output}${next}${skipped}`;
}

/** What a proof run leaves for the operator's view of it: the file, its evidence, and what a pass takes on trust or leaves out. */
export interface ProveDetails {
  readonly path: string;
  readonly evidence: Evidence;
  readonly trusted: readonly OnTrust[];
}

function text(content: string): ToolResult<ProveDetails | undefined> {
  return { content: [{ type: "text", text: content }], details: undefined };
}

/**
 * A proof's result: what the agent reads, its evidence for the operator, and
 * an error unless the proof passed with every specification line read.
 */
function proved(path: string, evidence: Evidence, trusted: readonly OnTrust[], unread: readonly { line: number; text: string }[]):
  ToolResult<ProveDetails | undefined> {
  return { content: [{ type: "text", text: proofReport(path, evidence, true, trusted, unread) }], details: { path, evidence, trusted },
    ...evidence.outcome === "passed" && unread.length === 0 ? {} : { isError: true } };
}

/** `prove` and its file, with how long the proof took at the right once it has run. */
function renderCall(args: { path?: string }, theme: Theme, context: { readonly durationMs: number | undefined }): Rows {
  const title = `${theme.fg("toolTitle", bold("prove"))} ${theme.fg("accent", args.path ?? "")}`;
  return new Rows((width) => [context.durationMs === undefined ? title
    : spread(title, theme.fg("dim", `${(context.durationMs / 1000).toFixed(1)}s`), width)]);
}

/**
 * A proof's result in a few words: proved, or not proved with Dafny's error
 * and the contract line it points at; Dafny's output when expanded. Pi draws
 * it on its error background unless the proof passed.
 */
function renderResult(result: ToolResult<ProveDetails | undefined>, options: { expanded: boolean; isPartial: boolean },
  theme: Theme): Rows {
  return new Rows((width) => {
    if (options.isPartial) return ["", theme.fg("accent", "◐ proving…")];
    const evidence = result.details?.evidence;
    if (evidence === undefined) {
      return ["", ...result.content.flatMap((part) => part.type === "text" ? part.text.split("\n") : [])
        .flatMap((line) => wrapUnder(theme.fg("toolOutput", line), width, 0))];
    }
    const summary = proofSummary(evidence);
    const passed = evidence.outcome === "passed";
    const trusted = result.details?.trusted ?? [];
    const words = trusted.length === 0 ? summary.words : "its contracts hold only if what it trusts is right";
    const head = passed ? `${theme.fg("success", trusted.length === 0 ? "✓ Proved" : "✓ Proved, not outright")}` +
      theme.fg("muted", ` — ${words}${summary.tally === undefined ? "" : ` · ${summary.tally}`}`)
      : `${theme.fg("error", "✗ Not proved")}${theme.fg("muted", ` — ${summary.words}`)}`;
    const output = quietOutput(evidence.output);
    return ["", ...wrapUnder(head, width, 2), ...summary.at === undefined ? [] : [theme.fg("muted", `   at ${summary.at}`)],
      ...trusted.flatMap((change) => wrapUnder(theme.fg("warning", `  ${trustLine(change)}`), width, 4)),
      ...options.expanded ? ["", ...output.flatMap((line) => wrapUnder(theme.fg("toolOutput", line), width, 2))]
        : passed || output.length === 0 ? [] : ["", expandHint(theme, "for Dafny's output")]];
  });
}

const parameters: TObject<{ path: TString }> = Type.Object({ path: Type.String({ description: "The TypeScript file to prove, relative to the project" }) });

/**
 * `prove`, inactive until the extension finds contracts (`hasContracts`). It
 * runs alone, since the evidence must describe the files as no other tool
 * call left them mid-proof.
 */
export const proveTool: ToolDefinition<typeof parameters, ProveDetails | undefined> = {
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
    const evidence = await proveFile(ctx.cwd, path, signal ?? new AbortController().signal);
    return proved(path, evidence, evidence.outcome === "passed" ? await trustedIn(ctx.cwd, evidence.files) : [],
      unreadSpecifications(source));
  },
  renderCall,
  renderResult,
};
