import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Pi the evaluation runs (#463): Tesota itself no longer runs on Pi, and
 * the evaluation keeps it as a development dependency until it runs on the
 * engine (#464).
 */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** An installed Pi: its package folder, its version and the program its `pi` command runs. */
export interface InstalledPi {
  readonly root: string;
  readonly version: string;
  readonly cli: string;
}

function manifest(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The Pi installed in the nearest `node_modules` folder from `folder` up, as Node finds a package. */
export function installedPi(folder: string): InstalledPi | undefined {
  for (let current = folder; ; current = dirname(current)) {
    const root = join(current, "node_modules", PI_PACKAGE);
    const pi = manifest(join(root, "package.json"));
    const bin = pi?.["bin"];
    const cli = typeof bin === "object" && bin !== null ? Reflect.get(bin, "pi") : undefined;
    if (typeof pi?.["version"] === "string" && typeof cli === "string") return { root, version: pi["version"], cli: join(root, cli) };
    if (dirname(current) === current) return undefined;
  }
}
