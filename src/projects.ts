import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "./languages.js";
import { below, builtIn, keepsProjectKind, pinnedIn } from "./verification/project-rule.js";

/**
 * The projects a repository holds, at its root or in folders below it to a
 * bounded depth (#318), so a monorepo whose JavaScript app and Java backend
 * sit in subfolders gets each one's checks and toolchain, as it would on
 * the operator's own machine. A project inside another of the same kind
 * belongs to it, as Gradle's settings, Maven's modules and Cargo's
 * workspaces build the projects below them, except that a JavaScript
 * package claims the packages below it only when it declares workspaces:
 * a root `package.json` often holds only the repository's tooling. A folder
 * that only states a language's version, as a root `.java-version` beside a
 * Gradle build in `backend/`, claims nothing, and is a project of that
 * language only when no folder below it builds one.
 */
export interface Project {
  /** Its folder, relative to the repository with forward slashes; empty for the root. */
  readonly folder: string;
  /** The names its folder holds. */
  readonly entries: readonly string[];
  /** The kinds its files show that no project around it builds: `node` for a JavaScript package, else a language's tool. */
  readonly kinds: readonly string[];
}

/** How many folders below the root the search reads, as `apps/web/client`. */
export const PROJECT_DEPTH = 3;

/** Folders that hold dependencies or build output, never a project of the repository's own; dot folders are skipped too. */
const skipped: ReadonlySet<string> = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "bin", "obj",
  "venv", "__pycache__"]);

/** The kinds a folder's names show, and those among them it only states a version of. */
function kindsIn(entries: readonly string[]): { present: string[]; pinned: string[] } {
  const pinned = LANGUAGES.filter((language) => pinnedIn(language.markers, language.versionFiles ?? [], entries)).map((language) => language.tool);
  return { present: [...entries.includes("package.json") ? ["node"] : [],
    ...LANGUAGES.filter((language) => builtIn(language.markers, entries) || pinned.includes(language.tool))
      .map((language) => language.tool)], pinned };
}

/** Whether a JavaScript package builds the packages below it: it declares workspaces, as npm, Yarn and Bun read them, or has pnpm's file. */
function declaresWorkspaces(directory: string, entries: readonly string[]): boolean {
  if (entries.includes("pnpm-workspace.yaml")) return true;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null && "workspaces" in manifest;
  } catch { return false; }
}

/** The repository's projects, the root's first, then each level's in name order. */
export function findProjects(checkout: string): Project[] {
  const found: (Project & { pinned: readonly string[] })[] = [];
  const queue: { folder: string; depth: number; claimed: ReadonlySet<string> }[] = [{ folder: "", depth: 0, claimed: new Set() }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const directory = join(checkout, next.folder);
    let names: Dirent[];
    try { names = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const entries = names.map((entry) => entry.name).sort();
    const { present, pinned } = kindsIn(entries);
    const kinds = present.filter((kind) => !next.claimed.has(kind));
    if (present.length > 0) found.push({ folder: next.folder, entries, kinds, pinned });
    if (next.depth >= PROJECT_DEPTH) continue;
    const claimed = new Set([...next.claimed,
      ...kinds.filter((kind) => !pinned.includes(kind) && (kind !== "node" || declaresWorkspaces(directory, entries)))]);
    const folders = names.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skipped.has(entry.name))
      .map((entry) => entry.name).sort();
    for (const name of folders) {
      queue.push({ folder: next.folder === "" ? name : `${next.folder}/${name}`, depth: next.depth + 1, claimed });
    }
  }
  return found.map(({ folder, entries, kinds, pinned }) => ({ folder, entries, kinds: kinds.filter((kind) => keepsProjectKind(pinned.includes(kind),
    found.some((other) => below(folder, other.folder) && other.kinds.includes(kind) && !other.pinned.includes(kind)))) }));
}

/** A file of a project's, relative to the repository. */
export function inProject(folder: string, file: string): string {
  return folder === "" ? file : `${folder}/${file}`;
}

/** A command run from a project's folder, as the POSIX shell every environment runs commands in reads it from the root. */
export function inFolder(folder: string, command: string): string {
  if (folder === "") return command;
  // A folder starting with `-` would read as an option, quoted or not.
  const path = folder.startsWith("-") ? `./${folder}` : folder;
  const word = /^[\w.][\w./-]*$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
  return `cd ${word} && ${command}`;
}
