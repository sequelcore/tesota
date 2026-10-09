import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { versionAtLeast } from "./verification/pi-version-rule.js";

/** The npm package that provides Pi, which Tesota declares as an optional peer dependency. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

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
    if (typeof pi?.["version"] === "string" && typeof cli === "string") return { root, version: pi["version"], cli: join(root, cli) };
    if (dirname(current) === current) return undefined;
  }
}

/** The Pi package that holds `file`, from the nearest named `package.json` up. */
function piHolding(file: string): InstalledPi | undefined {
  for (let current = dirname(file); dirname(current) !== current; current = dirname(current)) {
    const pi = manifest(join(current, "package.json"));
    if (pi?.["name"] === undefined) continue;
    return pi["name"] === PI_PACKAGE && typeof pi["version"] === "string" && existsSync(file)
      ? { root: current, version: pi["version"], cli: file } : undefined;
  }
  return undefined;
}

/**
 * The script a package manager's shim runs: the quoted `.js` path relative
 * to the shim's folder, `%dp0%\` or `%~dp0\` in npm's and pnpm's Windows
 * shims, `$basedir/` in their shell shims.
 */
function shimTarget(shim: string): string | undefined {
  try {
    if (statSync(shim).size > 64 * 1024) return undefined;
    const relative = /"(?:%~?dp0%?|\$basedir)[\\/]([^"]+?\.[cm]?js)"/u.exec(readFileSync(shim, "utf8"))?.[1];
    return relative === undefined ? undefined : resolve(dirname(shim), relative.replaceAll("\\", "/"));
  } catch {
    return undefined;
  }
}

/**
 * The Pi that the first `pi` command on `PATH` runs, as a script Tesota runs
 * with Node, so the operator's arguments never pass through a shell. On
 * Windows that is the script `pi.cmd` names; elsewhere the script `pi` links
 * to, as npm installs it, or the one a shell shim names. A `pi` that is not
 * an installed Pi package, such as a standalone binary, is not used.
 */
export function piOnPath(pathVariable: string, platform: NodeJS.Platform): InstalledPi | undefined {
  const windows = platform === "win32";
  for (const folder of pathVariable.split(windows ? ";" : ":").filter((entry) => entry !== "")) {
    const command = join(folder, windows ? "pi.cmd" : "pi");
    if (!existsSync(command)) continue;
    const linked = windows ? undefined : piHolding(realpathSync(command));
    const target = linked === undefined ? shimTarget(command) : undefined;
    return linked ?? (target === undefined ? undefined : piHolding(target));
  }
  return undefined;
}

/** The module Pi's package exports, which holds its `SessionManager`. */
export function piModule(pi: InstalledPi): string {
  const exported = manifest(join(pi.root, "package.json"))?.["exports"];
  const main = typeof exported === "object" && exported !== null ? Reflect.get(exported, ".") : undefined;
  const entry = typeof main === "object" && main !== null ? Reflect.get(main, "import") : undefined;
  if (typeof entry !== "string") throw new Error(`The Pi at ${pi.root} exports no module Tesota can import.`);
  return join(pi.root, entry);
}

/** The minimum Pi version in Tesota's `package.json`, whose peer range has the form `>=X.Y.Z`. */
export function minimumPiVersion(packageRoot: string): string {
  const peers = manifest(join(packageRoot, "package.json"))?.["peerDependencies"];
  const range = typeof peers === "object" && peers !== null ? Reflect.get(peers, PI_PACKAGE) : undefined;
  const minimum = typeof range === "string" ? /^>=(\d+\.\d+\.\d+)$/u.exec(range)?.[1] : undefined;
  if (minimum === undefined) throw new Error(`Tesota's package.json must declare ${PI_PACKAGE} as a peer with a ">=X.Y.Z" range.`);
  return minimum;
}

/**
 * The extension files the `pi` manifest in Tesota's `package.json` names
 * that are missing. Pi skips a missing extension without a word, so the
 * launcher checks first rather than open Pi without Tesota.
 */
export function missingExtensions(packageRoot: string): string[] {
  const extensions = manifest(join(packageRoot, "package.json"))?.["pi"];
  const paths = typeof extensions === "object" && extensions !== null ? Reflect.get(extensions, "extensions") : undefined;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string")) {
    throw new Error("Tesota's package.json must name its extension files in pi.extensions.");
  }
  return paths.map((path: string) => join(packageRoot, path)).filter((path) => !existsSync(path));
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
  const install = `Install it with npm install --global ${PI_PACKAGE}@latest, or ` +
    `npm install ${PI_PACKAGE}@latest in a project that has Tesota as a dependency.`;
  if (pi === undefined) return `Tesota runs inside Pi ${minimum} or later, and found no Pi beside it or on PATH. ${install}`;
  const found = release(pi.version);
  const wanted = release(minimum);
  if (wanted === undefined) throw new Error(`Invalid minimum Pi version: ${minimum}`);
  if (found !== undefined && versionAtLeast(...found, ...wanted)) return undefined;
  return `Tesota needs Pi ${minimum} or later, and the Pi it found is ${pi.version}. ${install}`;
}
