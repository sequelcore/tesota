import type { Mode } from "./permission-rule.ts";

export type Admission = "start" | "too_deep" | "too_many" | "read_only";

/**
 * Whether a session `depth` sessions below its top one may start a child
 * (#525): the child would be one deeper, so it starts only while `depth` is
 * below `maxDepth`; with fewer than `maxRunning` children running across the
 * top session's tree; and, when it would write, only in a session that may
 * write itself. Depth is refused first, then writing, then the count.
 */
//@ requires depth >= 0 && maxDepth >= 0 && running >= 0 && maxRunning >= 0
//@ ensures \result === "too_deep" <==> depth >= maxDepth
//@ ensures \result === "read_only" <==> depth < maxDepth && writes && readOnly
//@ ensures \result === "too_many" <==> depth < maxDepth && !(writes && readOnly) && running >= maxRunning
//@ ensures \result === "start" <==> depth < maxDepth && !(writes && readOnly) && running < maxRunning
export function admitChild(depth: number, maxDepth: number, running: number, maxRunning: number, writes: boolean, readOnly: boolean): Admission {
  if (depth >= maxDepth) return "too_deep";
  if (writes && readOnly) return "read_only";
  if (running >= maxRunning) return "too_many";
  return "start";
}

/**
 * The permission mode a child runs in (#525): a child that only reads is
 * read only whatever its parent's mode; a writing child takes its parent's
 * mode, never a wider one.
 */
//@ ensures !writes ==> \result === "read"
//@ ensures writes ==> \result === parent
export function childMode(parent: Mode, writes: boolean): Mode {
  if (!writes) return "read";
  return parent;
}
