import { createInterface } from "node:readline/promises";
import { runTaskProposalCommand } from "./task-proposal.js";

export interface NativeShellDependencies {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly propose: (request: string) => Promise<number>;
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
      ask: async (prompt) => terminal.question(prompt),
      propose: runTaskProposalCommand,
    });
  } catch {
    process.stderr.write("Tesota session ended before a proposal completed. Nothing changed.\n");
    return 1;
  } finally {
    terminal.close();
  }
}
