import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { OPAQUE_PI_REVIEWER_LIMITS, runOpaquePiReviewer } from "./integrations/pi-opaque-reviewer.js";

export const PI_REVIEW_RELAY_ARGUMENTS: readonly string[] = Object.freeze([
  "--print", "--mode", "text", "--no-session", "--no-tools", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
]);

export interface PiReviewRelayDependencies {
  readonly reviewer: typeof runOpaquePiReviewer;
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (bytes: Buffer) => void;
}

async function readPrompt(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    length += chunk.byteLength;
    if (length > OPAQUE_PI_REVIEWER_LIMITS.promptBytes) throw new Error("Pi relay prompt exceeds the byte bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

/** Implements only Gentle's fixed, tool-free Pi process transport. */
export async function runPiReviewRelay(arguments_: readonly string[], dependencies: PiReviewRelayDependencies): Promise<void> {
  if (JSON.stringify(arguments_) !== JSON.stringify(PI_REVIEW_RELAY_ARGUMENTS)) {
    throw new Error("Pi relay arguments are not admitted");
  }
  const result = await dependencies.reviewer(await readPrompt(dependencies.input));
  dependencies.write(result.stdout);
}

const entry = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const isEntry = entry !== undefined && (process.platform === "win32"
  ? resolve(entry).toLowerCase() === modulePath.toLowerCase()
  : resolve(entry) === modulePath);
if (isEntry) {
  runPiReviewRelay(process.argv.slice(2), {
    reviewer: runOpaquePiReviewer,
    input: process.stdin,
    write: (bytes) => { process.stdout.write(bytes); },
  }).catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message + "\n" : "Pi relay failed\n");
    process.exitCode = 1;
  });
}
