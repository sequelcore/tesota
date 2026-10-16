import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBase } from "./base.ts";
import type { ExtensionFactory } from "../../../src/contract.ts";
import { createSession, type EngineSession, type SessionOptions, openSession } from "./session.ts";

/** Tool rounds in the measured loop: each writes a file and reads it back. */
const loopRounds = 50;

/** Tool rounds in the resumed session: six entries each, about 1,000 in all. */
const resumeRounds = 166;

/** A verifier that settles each run at once, so the measurement times the engine's settlement and not a check (#439). */
const settles: ExtensionFactory = (pi) => { pi.on("agent_before_settle", () => undefined); };

/** A scripted model's models and model, for `rounds` rounds of write and read, then an answer, with a verifier. */
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
  return { models, model: faux.getModel(), verifier: settles };
}

/** Runs `measure` with a session of `rounds` rounds in temporary folders, with no network, and removes them after. */
async function measured(rounds: number, measure: (session: EngineSession, run: () => Promise<number>) => Promise<object>,
  timing: Pick<SessionOptions, "captureBase" | "writer"> = {}): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-measure-"));
  const sessions = mkdtempSync(join(tmpdir(), "tesota-core-measure-sessions-"));
  try {
    const session = createSession({ cwd, folder: sessions, ...scripted(rounds), ...timing });
    const run = async (): Promise<number> => {
      const started = performance.now();
      await session.prompt("measure");
      const ms = performance.now() - started;
      await session.dispose();
      if (session.outcome() !== "completed") throw new Error(`The measured run ended ${session.outcome() ?? "without an outcome"}.`);
      return tenths(ms);
    };
    console.log(JSON.stringify(await measure(session, run)));
  } finally {
    for (const folder of [cwd, sessions]) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

const tenths = (ms: number): number => Math.round(ms * 10) / 10;

/**
 * The loop's own cost, for the budget check (#435): a scripted model drives
 * `loopRounds` rounds of write and read in a session that records and syncs
 * it as any session does (#437). What the system and the disk decide is
 * timed apart: the request's base, a snapshot of the new folder, paid once
 * a request, and each sync to the disk, which takes 0.3 ms on one machine
 * and 10 ms on another. Prints the run's milliseconds without them, the
 * base's, the median sync's, the number of syncs, which the code decides
 * and the disk does not, the settlement's (#439), from its first entry to
 * the run's end without its syncs, and the process's resident memory as JSON.
 */
export function measureLoop(): Promise<void> {
  let baseMs = 0;
  const syncs: number[] = [];
  /** When settlement began and ended, and how many syncs came before each. */
  let settling: { started: number; syncsBefore: number; ended?: number; syncsAtEnd?: number } | undefined;
  const captureTimed: NonNullable<SessionOptions["captureBase"]> = async (cwd) => {
    const started = performance.now();
    try { return await captureBase(cwd); } finally { baseMs += performance.now() - started; }
  };
  const syncTimed: NonNullable<SessionOptions["writer"]> = (writer) => ({
    ...writer,
    append: (entry) => {
      if (entry.type === "settle" && settling === undefined) settling = { started: performance.now(), syncsBefore: syncs.length };
      if (entry.type === "run_end" && settling !== undefined) { settling.ended = performance.now(); settling.syncsAtEnd = syncs.length; }
      writer.append(entry);
    },
    sync: () => {
      const started = performance.now();
      try { writer.sync(); } finally { syncs.push(performance.now() - started); }
    },
  });
  return measured(loopRounds, async (_session, run) => {
    const runMs = await run();
    const syncedMs = syncs.reduce((sum, ms) => sum + ms, 0);
    const sorted = [...syncs].sort((a, b) => a - b);
    const settleSyncs = syncs.slice(settling?.syncsBefore ?? 0, settling?.syncsAtEnd ?? 0).reduce((sum, ms) => sum + ms, 0);
    const settleMs = settling?.ended === undefined ? 0 : settling.ended - settling.started - settleSyncs;
    return { settleMs: Math.round(settleMs * 100) / 100, loopMs: tenths(runMs - baseMs - syncedMs), baseMs: tenths(baseMs), syncMs: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100) / 100,
      syncCount: syncs.length, loopRssBytes: process.memoryUsage().rss };
  }, { captureBase: captureTimed, writer: syncTimed });
}

/**
 * Resuming a session of about 1,000 entries (#437): reading, checking and
 * recovering its file and rebuilding its conversation. Prints the
 * milliseconds that took and the file's size as JSON.
 */
export function measureResume(): Promise<void> {
  return measured(resumeRounds, async (session, run) => {
    await run();
    const { models, model, verifier } = scripted(0);
    const started = performance.now();
    const resumed = openSession(session.file, { models, model, verifier });
    const resumeMs = tenths(performance.now() - started);
    await resumed.dispose();
    return { resumeMs, sessionBytes: statSync(session.file).size };
  });
}
