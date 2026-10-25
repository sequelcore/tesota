import { fileURLToPath } from "node:url";
import { inBinary } from "./binary.js";
import { gitOutput } from "./git.js";
import { host } from "./host.js";

/** Tesota's own checkout: the folder above `src/`, never the workspace Tesota works on (#639). */
const ownFolder = fileURLToPath(new URL("..", import.meta.url));

/**
 * The engine a receipt names (#639): a released binary's plain version; a build
 * from source, the version plus the commit of `folder`, Tesota's own checkout,
 * and `.dirty` when it has changes, or `+unknown` when Git can't read it.
 */
async function read(version: string, from: { released: boolean; folder: string }): Promise<string> {
  if (from.released) return version;
  const prefix = await gitOutput(from.folder, ["rev-parse", "--show-prefix"]);
  const commit = typeof prefix === "string" && prefix.trim() === "" ? await gitOutput(from.folder, ["rev-parse", "--short=8", "HEAD"]) : undefined;
  if (typeof commit !== "string" || commit.trim() === "") return `${version}+unknown`;
  const changes = await gitOutput(from.folder, ["status", "--porcelain", "--untracked-files=all"]);
  return `${version}+${commit.trim()}${typeof changes !== "string" || changes.trim() !== "" ? ".dirty" : ""}`;
}

/** How long Git may take to name the commit before the engine is `+unknown`, so a stalled Git can't hold up a receipt. */
const lookupLimitMs = 10_000;

export async function engineOf(version: string, from: { released: boolean; folder: string }): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unknown = new Promise<string>((resolve) => { timer = setTimeout(() => { resolve(`${version}+unknown`); }, lookupLimitMs); });
  try { return await Promise.race([read(version, from), unknown]); } finally { clearTimeout(timer); }
}

let named: Promise<string> | undefined;

/** The engine this process names in a receipt, read once, when the first receipt needs it. */
export function engineName(): Promise<string> {
  return named ??= engineOf(host().version, { released: inBinary, folder: ownFolder });
}
