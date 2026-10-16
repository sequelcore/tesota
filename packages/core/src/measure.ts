import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBase } from "./base.ts";
import { createSession, type EngineSession, type SessionOptions, openSession } from "./session.ts";

/** Tool rounds in the measured loop: each writes a file and reads it back. */
const loopRounds = 50;

/** Tool rounds in the resumed session: six entries each, about 1,000 in all. */
const resumeRounds = 166;

/** A scripted model's models and model, for `rounds` rounds of write and read, then an answer. */
function scripted(rounds: number) {
  const faux = fauxProvider();
  faux.setResponses([
    ...Array.from({ length: rounds }, (_, round) => [
      fauxAssistantMessage([fauxToolCall("write", { path: `file-${round}.txt`, content: `round ${round}\n`.repeat(100) })],
        { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: `file-${round}.txt` })], { stopReason: "toolUse" }),
    ]).flat(),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() };
}

/** Runs `measure` with a session of `rounds` rounds in temporary folders, with no network, and removes them after. */
async function measured(rounds: number, measure: (session: EngineSession, run: () => Promise<number>) => Promise<object>,
  base?: SessionOptions["captureBase"]): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-measure-"));
  const sessions = mkdtempSync(join(tmpdir(), "tesota-core-measure-sessions-"));
  try {
    const session = createSession({ cwd, folder: sessions, ...scripted(rounds), ...base === undefined ? {} : { captureBase: base } });
    const run = async (): Promise<number> => {
      const started = performance.now();
      await session.prompt("measure");
      const ms = performance.now() - started;
      await session.dispose();
      if (session.outcome() !== "completed") throw new Error(`The measured run ended ${session.outcome() ?? "without an outcome"}.`);
      return Math.round(ms * 10) / 10;
    };
    console.log(JSON.stringify(await measure(session, run)));
  } finally {
    for (const folder of [cwd, sessions]) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * The loop's own cost, for the budget check (#435): a scripted model drives
 * `loopRounds` rounds of write and read in a session that records and syncs
 * it as any session does (#437). The request's base, a snapshot of the new
 * folder, is timed apart: it is paid once a request, not once a call.
 * Prints the run's milliseconds without the base, the base's, and the
 * process's resident memory as JSON.
 */
export function measureLoop(): Promise<void> {
  let baseMs = 0;
  const timed: NonNullable<SessionOptions["captureBase"]> = async (cwd) => {
    const started = performance.now();
    try { return await captureBase(cwd); } finally { baseMs += performance.now() - started; }
  };
  return measured(loopRounds, async (_session, run) => {
    const runMs = await run();
    return { loopMs: Math.round((runMs - baseMs) * 10) / 10, baseMs: Math.round(baseMs * 10) / 10, loopRssBytes: process.memoryUsage().rss };
  }, timed);
}

/**
 * Resuming a session of about 1,000 entries (#437): reading, checking and
 * recovering its file and rebuilding its conversation. Prints the
 * milliseconds that took and the file's size as JSON.
 */
export function measureResume(): Promise<void> {
  return measured(resumeRounds, async (session, run) => {
    await run();
    const { models, model } = scripted(0);
    const started = performance.now();
    const resumed = openSession(session.file, { models, model });
    const resumeMs = Math.round((performance.now() - started) * 10) / 10;
    await resumed.dispose();
    return { resumeMs, sessionBytes: statSync(session.file).size };
  });
}
