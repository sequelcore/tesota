import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Terminal } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provideHost } from "../../../../src/host.ts";
import tesota from "../../../../src/tesota.ts";
import { loopRounds, scripted } from "../measure.ts";
import { engineModels } from "../model-access.ts";
import { createSession } from "../session.ts";
import { startShell } from "./shell.ts";
import { createSurface, shellHost } from "./surface.ts";
import { shellTheme } from "../../../../src/theme.ts";

/** A terminal that keeps only when it was first drawn on, for measuring the shell without one. */
class CountingTerminal implements Terminal {
  firstFrameMs: number | undefined;
  readonly columns = 100;
  readonly rows = 30;
  readonly kittyProtocolActive = false;
  start(): void { /* no input */ }
  stop(): void { /* nothing to restore */ }
  async drainInput(): Promise<void> { /* no input */ }
  write(data: string): void { if (this.firstFrameMs === undefined && /[a-z]/iu.test(data)) this.firstFrameMs = performance.now(); }
  moveBy(): void { /* drawn nowhere */ }
  hideCursor(): void { /* drawn nowhere */ }
  showCursor(): void { /* drawn nowhere */ }
  clearLine(): void { /* drawn nowhere */ }
  clearFromCursor(): void { /* drawn nowhere */ }
  clearScreen(): void { /* drawn nowhere */ }
  setTitle(): void { /* drawn nowhere */ }
  setProgress(): void { /* drawn nowhere */ }
  setProgramStatus(): void { /* drawn nowhere */ }
}

const tenths = (ms: number): number => Math.round(ms * 10) / 10;

/**
 * The shell's own budget (#444): the milliseconds from the process's start
 * to the shell's first frame, and the process's resident memory once it has
 * drawn the scripted loop's conversation (`loopRounds` rounds of write and
 * read, as `--measure-loop` runs them). The shell draws Tesota's own
 * interface, its header with the tree included, as `tesota-core` does (#446),
 * and the session settles as the loop's measurement does. Printed as JSON.
 */
export async function measureShell(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-measure-shell-"));
  const sessions = mkdtempSync(join(tmpdir(), "tesota-core-measure-sessions-"));
  try {
    const terminal = new CountingTerminal();
    provideHost(shellHost());
    const theme = shellTheme("dark", "truecolor");
    const surface = createSurface(theme);
    // Tesota as an extension draws its interface; the measured run settles at once, so the gate's checks are not timed here.
    // The models are the real shell's, pi-ai's provider catalog included, as `runApp` loads them before its first frame (#600),
    // with no credentials or accounts, and the scripted model added to them.
    const session = createSession({ cwd, folder: sessions, ...scripted(loopRounds, engineModels(new InMemoryCredentialStore(), [])),
      extensions: [(pi) => { tesota(pi); }], surface, mode: "tui" });
    const shell = startShell({ terminal, mode: "fullscreen", fullRepaint: false, theme, session, status: () => "measure", surface });
    while (terminal.firstFrameMs === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    await session.prompt("measure");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const shellRssBytes = process.memoryUsage().rss;
    shell.stop();
    await session.dispose();
    console.log(JSON.stringify({ firstFrameMs: tenths(terminal.firstFrameMs), shellRssBytes }));
  } finally {
    for (const folder of [cwd, sessions]) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}
