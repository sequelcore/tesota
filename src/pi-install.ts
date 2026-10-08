import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { versionAtLeast } from "./verification/pi-version-rule.js";

/** The npm package that provides Pi, which Tesota declares as an optional peer dependency. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** An installed Pi: its version and the program its `pi` command runs. */
export interface InstalledPi {
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

/**
 * The Pi installed beside Tesota, found as Node finds a package: in the
 * nearest `node_modules` folder from `folder` up. A global install finds a
 * Pi installed globally by the same package manager, and a project install
 * finds the project's.
 */
export function installedPi(folder: string): InstalledPi | undefined {
  for (let current = folder; ; current = dirname(current)) {
    const root = join(current, "node_modules", PI_PACKAGE);
    const pi = manifest(join(root, "package.json"));
    const bin = pi?.["bin"];
    const cli = typeof bin === "object" && bin !== null ? Reflect.get(bin, "pi") : undefined;
    if (typeof pi?.["version"] === "string" && typeof cli === "string") return { version: pi["version"], cli: join(root, cli) };
    if (dirname(current) === current) return undefined;
  }
}

/** The minimum Pi version in Tesota's `package.json`, whose peer range has the form `>=X.Y.Z`. */
export function minimumPiVersion(packageRoot: string): string {
  const peers = manifest(join(packageRoot, "package.json"))?.["peerDependencies"];
  const range = typeof peers === "object" && peers !== null ? Reflect.get(peers, PI_PACKAGE) : undefined;
  const minimum = typeof range === "string" ? /^>=(\d+\.\d+\.\d+)$/u.exec(range)?.[1] : undefined;
  if (minimum === undefined) throw new Error(`Tesota's package.json must declare ${PI_PACKAGE} as a peer with a ">=X.Y.Z" range.`);
  return minimum;
}

const release = (version: string): readonly [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Why Tesota cannot run on this Pi, or undefined when it can. A prerelease
 * counts as its release.
 */
export function piProblem(pi: InstalledPi | undefined, minimum: string): string | undefined {
  const install = `Install it where Tesota is installed: npm install --global ${PI_PACKAGE}@latest, or ` +
    `npm install ${PI_PACKAGE}@latest in a project that has Tesota as a dependency.`;
  if (pi === undefined) return `Tesota runs inside Pi ${minimum} or later, and Pi is not installed beside it. ${install}`;
  const found = release(pi.version);
  const wanted = release(minimum);
  if (wanted === undefined) throw new Error(`Invalid minimum Pi version: ${minimum}`);
  if (found !== undefined && versionAtLeast(...found, ...wanted)) return undefined;
  return `Tesota needs Pi ${minimum} or later, and the Pi installed beside it is ${pi.version}. ${install}`;
}
