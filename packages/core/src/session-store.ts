import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionStore } from "../../../src/pull-request-receipt.ts";
import { branchOf } from "./branch.ts";
import { sessionsFolder } from "./session.ts";
import { peekSessionFile } from "./session-file.ts";

/**
 * The engine's sessions as `tesota receipt` reads them (#463): the session
 * files of a folder, and each one's entries as its branch, read without
 * touching a file another Tesota may be writing.
 */
export const sessionStore: SessionStore = {
  list: (cwd) => {
    const folder = sessionsFolder(cwd);
    let names: string[];
    try { names = readdirSync(folder); } catch { return Promise.resolve([]); }
    return Promise.resolve(names.filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ path: join(folder, name), modified: statSync(join(folder, name)).mtime })));
  },
  open: (path) => {
    const { entries } = peekSessionFile(path);
    return { getSessionId: () => basename(path, ".jsonl"), getBranch: () => branchOf(entries) };
  },
};
