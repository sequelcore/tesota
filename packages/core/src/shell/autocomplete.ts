import {
  type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, CombinedAutocompleteProvider, fuzzyFilter, type SlashCommand,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { git } from "../../../../src/git.ts";

const refreshMs = 3_000;
const walkEntries = 20_000;
const walkDepth = 8;

/**
 * The folder's files as Git lists them (`git`, which knows Tesota's
 * snapshots), untracked ones included and ignored ones left out, in NUL
 * records that keep spaces and Unicode; undefined outside a repository or
 * when Git fails.
 */
async function gitFiles(cwd: string): Promise<string[] | undefined> {
  return (await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))?.split("\0").filter(Boolean);
}

/** Bound work by entries visited, depth and time; never follow links out of the session's folder. */
async function walkFiles(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  const pending = [{ path: "", depth: 0 }];
  const until = performance.now() + 2_000;
  let visited = 0;
  while (pending.length > 0 && visited < walkEntries && performance.now() < until) {
    const next = pending.shift();
    if (next === undefined) break;
    try {
      const directory = await opendir(join(cwd, next.path));
      for await (const entry of directory) {
        if (++visited > walkEntries || performance.now() >= until) break;
        const path = next.path + entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          paths.push(`${path}/`);
          if (next.depth < walkDepth) pending.push({ path: `${path}/`, depth: next.depth + 1 });
        } else if (entry.isFile()) paths.push(path);
      }
    } catch { /* unreadable or removed while walking */ }
  }
  return paths;
}

/** The session's fuzzy @ mentions, with pi-tui owning commands, ordinary paths and insertion. */
export class FileAutocompleteProvider implements AutocompleteProvider {
  private readonly combined: CombinedAutocompleteProvider;
  private readonly cwd: string;
  private files: string[] | undefined;
  private pending: Promise<string[]> | undefined;
  private refreshed = 0;

  constructor(commands: (SlashCommand | AutocompleteItem)[], cwd: string) {
    this.cwd = cwd;
    this.combined = new CombinedAutocompleteProvider(commands, cwd);
  }

  private list(): Promise<string[]> {
    if (this.pending !== undefined) return this.pending;
    if (this.files === undefined || Date.now() - this.refreshed >= refreshMs) {
      this.pending = (async () => {
        const files = await gitFiles(this.cwd) ?? await walkFiles(this.cwd);
        const paths = new Set(files);
        for (const file of files) {
          for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1)) {
            paths.add(file.slice(0, slash + 1));
          }
        }
        this.files = [...paths].sort();
        this.refreshed = Date.now();
        return this.files;
      })().finally(() => {
        this.pending = undefined;
      });
      return this.pending;
    }
    return Promise.resolve(this.files);
  }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number,
    options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    if (options.signal.aborted) return null;
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const prefix = /(?:^|[\s"'=])[([{<`]*(@(?:"[^"]*|[^\s"'=]*)$)/u.exec(before)?.[1];
    if (prefix === undefined) return this.combined.getSuggestions(lines, cursorLine, cursorCol, options);
    try {
      // A cancelled keystroke stops waiting; the shared, bounded scan remains useful to the next one.
      const files = await Effect.runPromise(Effect.promise(() => this.list()), { signal: options.signal });
      if (options.signal.aborted) return null;
      const quoted = prefix.startsWith('@"');
      const query = prefix.slice(quoted ? 2 : 1).replaceAll("\\", "/");
      const displayBase = query.startsWith("./") ? "./" : "";
      const relative = query.slice(displayBase.length);
      const slash = relative.lastIndexOf("/");
      const scope = relative.slice(0, slash + 1);
      const scoped = slash >= 0 && files.includes(scope);
      const entries = scoped ? files.filter((path) => path.startsWith(scope) && path !== scope) : files;
      const items = fuzzyFilter(entries, scoped ? relative.slice(slash + 1) : relative, (path) => scoped ? path.slice(scope.length) : path)
        .slice(0, 20).map((path) => {
          const completion = displayBase + path;
          const description = completion.endsWith("/") ? completion.slice(0, -1) : completion;
          return { value: quoted || /\s/u.test(completion) ? `@"${completion}"` : `@${completion}`,
            label: basename(description) + (path.endsWith("/") ? "/" : ""), description };
        });
      return items.length === 0 ? null : { items, prefix };
    } catch { return null; }
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string):
    ReturnType<CombinedAutocompleteProvider["applyCompletion"]> {
    return this.combined.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.combined.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
