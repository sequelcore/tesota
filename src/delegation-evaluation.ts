/**
 * The delegation evaluation (decision 019): questions whose answers need
 * reading several files of a frozen copy of Tesota's own repository, asked
 * of the agent with and without explorers. Each answer is scored by the facts
 * it states, so the two modes differ only by the explorers.
 */

/** The commit the questions describe; their answers hold there. */
export const DELEGATION_COMMIT = "2cccf074";

/** One fact an answer must state: it counts when any of its phrasings appears. */
export type Fact = readonly string[];

export interface DelegationCase {
  readonly name: string;
  readonly question: string;
  readonly facts: readonly Fact[];
}

export const DELEGATION_CASES: readonly DelegationCase[] = [
  { name: "correction", question: "Which conditions must a review finding meet before Tesota sends it back to the " +
    "working agent for correction, and which file decides that?",
  facts: [["fixable"], ["introduced"], ["confirmed"], ["duplicate"], ["correction.ts"]] },
  { name: "depth", question: "How does Tesota decide whether a review is standard or deep? List every fact about the " +
    "candidate that makes it deep, and the file that decides it.",
  facts: [["sensitive"], ["test"], ["verifier", "check result", "not pass", "did not pass", "failed check"], ["400"], ["review-depth.ts"]] },
  { name: "store lock", question: "What stops two Tesota shells from opening the same repository's saved sessions at " +
    "once, and what happens when the earlier shell crashed?",
  facts: [["lock"], ["pid", "process id", "process"], ["shell-session-store.ts"], ["already has an open", "stale", "no longer running", "not running"]] },
  { name: "origin", question: "What does Tesota do with a review finding whose claim about being introduced by the " +
    "change is not supported by the diff, and where is that rule proved?",
  facts: [["unknown"], ["operator"], ["finding-origin"], ["dafny", "formal:check", "lemmascript"]] },
  { name: "live review flags", question: "Which command-line options does `bun run live:review` accept, and what does " +
    "each change?",
  facts: [["--depth"], ["--skip-corrections"], ["--model-reviewer"], ["--model-refuter"]] },
  { name: "windows programs", question: "How does Tesota find whoami and Windows PowerShell on Windows, and why does " +
    "it not rely on PATH?",
  facts: [["systemroot"], ["system32"], ["git bash"], ["windows-system.ts"]] },
];

export interface DelegationScore {
  readonly name: string;
  /** Facts the answer stated, of the facts the question needs. */
  readonly stated: number;
  readonly facts: number;
}

export function scoreAnswer(testCase: DelegationCase, answer: string): DelegationScore {
  const text = answer.toLowerCase();
  return { name: testCase.name, facts: testCase.facts.length,
    stated: testCase.facts.filter((fact) => fact.some((phrasing) => text.includes(phrasing.toLowerCase()))).length };
}
