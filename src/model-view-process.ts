import { fileURLToPath } from "node:url";
import { runProcess } from "./process.js";
import type { ModelView, ViewRequest } from "./model-view.js";

/** One request, one disposable process. Cancellation waits for runProcess's tree release. */
export async function loadModelView(manifest: string, request: ViewRequest, signal: AbortSignal): Promise<ModelView> {
  const entry = fileURLToPath(new URL("../packages/core/src/main.ts", import.meta.url));
  const binary = process.versions["bun"] !== undefined && !process.argv[1]?.endsWith(".ts");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  try {
    const result = await runProcess(binary ? process.execPath : "bun", [...binary ? [] : [entry], "__model-view"],
      process.cwd(), controller.signal, 30_000, undefined, { input: JSON.stringify({ manifest, request }), onStdout: chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) { oversized = true; controller.abort(); }
        else chunks.push(chunk);
      } });
    if (oversized) throw new Error("Model viewer response exceeds 64 MiB budget; use the raw graph artifacts");
    if (result.ended !== "exited" || result.exitCode !== 0) throw new Error(`Model viewer worker ${result.ended}: ${result.stderr}`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelView;
  } finally { signal.removeEventListener("abort", abort); }
}

export async function modelViewCommand(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--plain" || args[1] === undefined) throw new Error("Use: tesota graph --plain <manifest>");
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  process.once("SIGINT", stop);
  try {
    const text = (await loadModelView(args[1], {}, controller.signal)).plain;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, error => { if (error) reject(error); else resolve(); });
    });
  }
  finally { process.removeListener("SIGINT", stop); }
}
