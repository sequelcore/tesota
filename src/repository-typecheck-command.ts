import { createInterface } from "node:readline/promises";
import { askTerminalQuestion, type PromptTerminal } from "./terminal-question.js";
import { formatRepositoryTypecheckProfile, prepareRepositoryTypecheck, runRepositoryTypecheck,
  type RepositoryTypecheckProfile, type RepositoryTypecheckResult } from "./repository-typecheck.js";

interface RepositoryTypecheckCommandDependencies {
  readonly candidate: string;
  readonly source: string;
  readonly ask: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
  readonly prepare?: (options: { readonly candidate: string; readonly source: string }) => Promise<RepositoryTypecheckProfile>;
  readonly execute?: (profile: RepositoryTypecheckProfile, signal: AbortSignal) => Promise<RepositoryTypecheckResult>;
}

function approved(answer: string): boolean { return /^(?:y|yes)$/iu.test(answer.trim()); }

/** Explicit local approval is consumed in memory and never persisted as reusable execution authority. */
export async function startRepositoryTypecheck(dependencies: RepositoryTypecheckCommandDependencies): Promise<number> {
  const prepare = dependencies.prepare ?? prepareRepositoryTypecheck;
  const profile = await prepare({ candidate: dependencies.candidate, source: dependencies.source });
  dependencies.write(formatRepositoryTypecheckProfile(profile));
  if (!approved(await dependencies.ask("Run this exact repository check? [y/N] "))) {
    dependencies.write("Repository check not started. Nothing changed.\n");
    return 0;
  }
  const cancellation = new AbortController();
  const cancel = (): void => { cancellation.abort(); };
  process.once("SIGINT", cancel);
  try {
    const execute = dependencies.execute ?? ((value, signal) => runRepositoryTypecheck(value, undefined, signal));
    const result = await execute(profile, cancellation.signal);
    dependencies.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "passed") return 0;
    if (result.status === "check_failed") return 1;
    return result.status === "cancelled" ? 130 : 2;
  } finally { process.removeListener("SIGINT", cancel); }
}

export async function askRepositoryTypecheckQuestion(prompt: string,
  createTerminal: () => PromptTerminal = () => createInterface({ input: process.stdin, output: process.stdout, terminal: true })):
Promise<string> {
  return askTerminalQuestion(createTerminal(), prompt);
}

export async function runRepositoryTypecheckCommand(candidate: string): Promise<number> {
  if (process.platform !== "win32" || process.stdin.isTTY !== true || process.stdout.isTTY !== true ||
      process.stderr.isTTY !== true) {
    process.stderr.write("Repository typecheck requires an interactive Windows terminal. Nothing changed.\n");
    return 2;
  }
  try {
    return await startRepositoryTypecheck({ candidate, source: process.cwd(), ask: askRepositoryTypecheckQuestion,
      write: (text) => { process.stdout.write(text); } });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    process.stderr.write(cancelled ? "Repository typecheck cancelled.\n" :
      "Repository typecheck unavailable or failed. Inspect the candidate before retrying.\n");
    return cancelled ? 130 : 2;
  }
}
