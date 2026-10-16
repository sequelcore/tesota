import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoop } from "./loop.ts";

/** Tool rounds in the measured run: each writes a file and reads it back. */
const rounds = 50;

/**
 * The loop's own cost, for the budget check (#435): a scripted model drives
 * `rounds` rounds of write and read in a temporary folder, with no network.
 * Prints the run's milliseconds and the process's resident memory as JSON.
 */
export async function measureLoop(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-measure-"));
  try {
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
    const loop = createLoop({ cwd, models, model: faux.getModel() });
    const started = performance.now();
    await loop.prompt("measure");
    const loopMs = performance.now() - started;
    loop.dispose();
    if (loop.outcome() !== "completed") throw new Error(`The measured loop ended ${loop.outcome() ?? "without an outcome"}.`);
    console.log(JSON.stringify({ loopMs: Math.round(loopMs * 10) / 10, loopRssBytes: process.memoryUsage().rss }));
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
  }
}
