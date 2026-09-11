import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

export interface GentleProcessRequest {
  readonly executable: string;
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly effect: "read" | "write";
  readonly signal?: AbortSignal;
}

/** Each call uses an explicit executable, argv and repository; never a shell. */
export async function runGentleProcess(request: GentleProcessRequest): Promise<Buffer> {
  if (!isAbsolute(request.executable) || !isAbsolute(request.cwd)) throw new Error("Gentle requires absolute executable and repository paths");
  request.signal?.throwIfAborted();
  return await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(request.executable, [...request.arguments], {
      cwd: request.cwd,
      windowsHide: true,
      encoding: "buffer",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GENTLE_PI_REVIEW_RELAY_CONTRACT: "gentle-pi.review-relay/v1" },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, (error, stdout) => {
      if (error !== null) reject(new Error(request.effect === "write"
        ? "Gentle write failed; settlement is unconfirmed. Inspect bound provider status before retrying."
        : "Gentle read failed before producing usable output.", { cause: error }));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* The process callback reports pipe/process failure. */ });
    child.stdin?.end();
  });
}
