import { createInterface } from "node:readline/promises";
import { runTaskProposalCommand } from "./task-proposal.js";

export interface NativeShellDependencies {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly propose: (request: string) => Promise<number>;
}

export interface NativePromptTerminal {
  question(prompt: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
  close(): void;
}

/** Release readline after one request so later Ctrl+C reaches the active task owner. */
export async function askNativeShellRequest(terminal: NativePromptTerminal, prompt: string): Promise<string> {
  const cancellation = new AbortController();
  const interrupt = (): void => { cancellation.abort(); };
  terminal.once("SIGINT", interrupt);
  try {
    return await terminal.question(prompt, { signal: cancellation.signal });
  } finally {
    terminal.removeListener("SIGINT", interrupt);
    terminal.close();
  }
}

/** First Tesota-owned operator surface; execution remains a later admitted consumer. */
export async function runNativeShell(dependencies: NativeShellDependencies): Promise<number> {
  dependencies.write(
    `Tesota\nRepository: ${dependencies.cwd}\n` +
    "Describe the change you want. File names are optional.\n\n",
  );
  const request = (await dependencies.ask("> ")).trim();
  if (request.length === 0) {
    dependencies.write("No request entered. Nothing changed.\n");
    return 0;
  }

  dependencies.write("\nDiscovering scope and checks. Nothing will be changed.\n\n");
  const result = await dependencies.propose(request);
  dependencies.write(result === 0
    ? "Proposal ready. Execution from this session is not available yet.\n"
    : "Proposal blocked or unavailable. Nothing changed.\n");
  return result;
}

export async function runNativeShellCommand(): Promise<number> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await runNativeShell({
      cwd: process.cwd(),
      write: (text) => { process.stdout.write(text); },
      ask: async (prompt) => askNativeShellRequest(terminal, prompt),
      propose: runTaskProposalCommand,
    });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    process.stderr.write(cancelled
      ? "Tesota session cancelled. Nothing changed.\n"
      : "Tesota session ended before a proposal completed. Nothing changed.\n");
    return cancelled ? 130 : 1;
  } finally {
    terminal.close();
  }
}
