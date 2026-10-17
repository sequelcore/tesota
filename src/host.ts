/**
 * What Tesota's verification takes from the engine that runs it (#446):
 * the engine's shell gives these once, before Tesota loads, so the
 * verification layer in `src/` never imports the engine.
 */
export interface HostParts {
  /** The keys bound to an action, as the operator would press them. */
  readonly keyText: (action: string) => string;
  /** Tesota's version, as a receipt records what ran. */
  readonly version: string;
  /** The POSIX shell the project's checks run in: its path and arguments, and whether it reads the command from its input instead. */
  readonly shellConfig: () => { shell: string; args: string[]; commandTransport?: "argv" | "stdin" };
}

let given: HostParts | undefined;

/** Gives Tesota its engine's parts, once, before it loads. */
export function provideHost(parts: HostParts): void { given = parts; }

/** The engine's parts; an engine that loads Tesota without giving them is a mistake. */
export function host(): HostParts {
  if (given === undefined) throw new Error("Tesota's engine gave it no parts: provideHost must run before Tesota loads.");
  return given;
}
