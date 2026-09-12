export interface PromptTerminal {
  question(prompt: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
  close(): void;
}

/** A prompt owns readline only while input is pending, leaving later process signals to the active lifecycle owner. */
export async function askTerminalQuestion(terminal: PromptTerminal, prompt: string): Promise<string> {
  const cancellation = new AbortController();
  const interrupt = (): void => { cancellation.abort(); };
  terminal.once("SIGINT", interrupt);
  try { return await terminal.question(prompt, { signal: cancellation.signal }); }
  finally {
    terminal.removeListener("SIGINT", interrupt);
    terminal.close();
  }
}
