import { createInterface } from "node:readline/promises";
import { runRepositoryConversationCommand } from "./conversation-turn.js";

export interface NativeShellDependencies {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly discover: (request: string) => Promise<number>;
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
    "Ask about the repository or describe a change. File names are optional.\n\n",
  );
  const request = (await dependencies.ask("> ")).trim();
  if (request.length === 0) {
    dependencies.write("No request entered. Nothing changed.\n");
    return 0;
  }

  dependencies.write("\nInspecting the committed repository. Nothing will be changed.\n\n");
  const result = await dependencies.discover(request);
  dependencies.write(result === 0
    ? "Read-only turn complete. No execution authority was created.\n"
    : "Request blocked or unavailable. Nothing changed.\n");
  return result;
}

export async function runNativeShellCommand(): Promise<number> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await runNativeShell({
      cwd: process.cwd(),
      write: (text) => { process.stdout.write(text); },
      ask: async (prompt) => askNativeShellRequest(terminal, prompt),
      discover: runRepositoryConversationCommand,
    });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    process.stderr.write(cancelled
      ? "Tesota session cancelled. Nothing changed.\n"
      : "Tesota session ended before the read-only turn completed. Nothing changed.\n");
    return cancelled ? 130 : 1;
  } finally {
    terminal.close();
  }
}
