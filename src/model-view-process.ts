import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { runProcess } from "./process.js";
import type { ModelView, ViewRequest } from "./model-view.js";

/** One request, one disposable process. Cancellation waits for runProcess's tree release. */
export async function loadModelView(manifest: string, request: ViewRequest, signal: AbortSignal): Promise<ModelView> {
  return await modelWorkerRequest(manifest, request, signal, false) as ModelView;
}

export async function writeModelViewHtml(manifest: string, signal: AbortSignal): Promise<string> {
  return await modelWorkerRequest(manifest, {}, signal, true) as string;
}

async function modelWorkerRequest(manifest: string, request: ViewRequest, signal: AbortSignal, html: boolean): Promise<ModelView | string> {
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
      process.cwd(), controller.signal, 30_000, undefined, { input: JSON.stringify({ manifest, request, html }), onStdout: chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) { oversized = true; controller.abort(); }
        else chunks.push(chunk);
      } });
    if (oversized) throw new Error("Model viewer response exceeds 64 MiB budget; use the raw graph artifacts");
    // The worker's runtime prints a code frame before the error; its reason is the last `error:` line.
    const reason = [...result.stderr.matchAll(/^\s*(?:\w*Error|error): (.+)$/gmu)].at(-1)?.[1] ?? result.stderr.trim();
    if (result.ended !== "exited" || result.exitCode !== 0) throw new Error(`Model viewer worker ${result.ended}: ${reason}`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelView;
  } finally { signal.removeEventListener("abort", abort); }
}

/** Windows' ShellExecute entry point avoids cmd.exe's built-in `start` and its shell parsing. */
export async function openGraphHtml(path: string, platform: NodeJS.Platform = process.platform,
  launch: (file: string, args: readonly string[]) => Promise<void> = launchBrowser): Promise<void> {
  await launch(platform === "win32" ? win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "explorer.exe")
    : platform === "darwin" ? "/usr/bin/open" : "xdg-open", [path]);
}

async function launchBrowser(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { shell: false, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function modelViewCommand(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || !["--plain", "--html"].includes(args[0] ?? "") || args[1] === undefined) throw new Error("Use: tesota graph --plain|--html <manifest>");
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  process.once("SIGINT", stop);
  try {
    const text = args[0] === "--html" ? await writeModelViewHtml(args[1], controller.signal)
      : (await loadModelView(args[1], {}, controller.signal)).plain;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, error => { if (error) reject(error); else resolve(); });
    });
  }
  finally { process.removeListener("SIGINT", stop); }
}
