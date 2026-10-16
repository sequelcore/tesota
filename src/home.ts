import { homedir } from "node:os";
import { join } from "node:path";

/** Tesota's own state folder, `~/.tesota`: the engine's sessions and the snapshots of folders in no repository (#437). */
export function tesotaHome(): string {
  return join(homedir(), ".tesota");
}
