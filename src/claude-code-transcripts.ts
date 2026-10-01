import { existsSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeCodeRouteDirectory } from "./integrations/model-session.js";
import { type AddedRoute, readAddedRoutes } from "./model-roles.js";

/**
 * Claude Code keeps each conversation as `<id>.jsonl`, with a folder of the
 * same name for what its tools wrote, under `projects/<folder>` in its
 * configuration folder, the folder named after the working directory. Tesota
 * removes only the conversations whose ids its sessions recorded: a project
 * folder for the operator's own repository also holds their own Claude Code
 * conversations. A project folder of one of Tesota's isolated workspaces is
 * Tesota's alone, so once that workspace is gone, all of it goes.
 */

/** The configuration folders Tesota's Claude Code routes use: the operator's own, and each added route's (decision 050). */
export function claudeCodeConfigDirectories(added: readonly AddedRoute[] = readAddedRoutes()): string[] {
  const own = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  return [own, ...added.filter((route) => route.kind === "claude-code").map((route) => claudeCodeRouteDirectory(route.name))];
}

/** The project folder Claude Code names after a working directory: every character but a letter or a digit becomes `-`. */
export function claudeProjectFolder(workingDirectory: string): string {
  return resolve(workingDirectory).replace(/[^A-Za-z0-9]/gu, "-");
}

async function projectFolders(configDirectory: string): Promise<string[]> {
  const projects = join(configDirectory, "projects");
  try {
    return (await readdir(projects, { withFileTypes: true })).filter((entry) => entry.isDirectory())
      .map((entry) => join(projects, entry.name));
  } catch { return []; }
}

const conversationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Remove these conversations from every project folder of these configuration
 * folders, by id alone, and a project folder they leave empty; how many were removed.
 */
export async function removeClaudeTranscripts(ids: readonly string[],
  configDirectories: readonly string[] = claudeCodeConfigDirectories()): Promise<number> {
  const named = ids.filter((id) => conversationId.test(id));
  let removed = 0;
  for (const directory of configDirectories) {
    for (const project of await projectFolders(directory)) {
      let here = 0;
      for (const id of named) {
        const transcript = join(project, `${id}.jsonl`);
        if (existsSync(transcript)) { await rm(transcript, { force: true }); here += 1; }
        if (existsSync(join(project, id))) { await rm(join(project, id), { recursive: true, force: true }); here += 1; }
      }
      removed += here;
      // Only a folder these conversations emptied goes: anything else in it is not theirs.
      if (here > 0) try { await rmdir(project); } catch { /* not empty */ }
    }
  }
  return removed;
}

/**
 * Project folders of Tesota's isolated workspaces under `workspacesRoot` that no
 * longer exist: each workspace's checkout is `<workspacesRoot>/<id>/repo`, so
 * its folder is that path's name, and nothing but Tesota's sessions worked there.
 */
export async function orphanedWorkspaceTranscripts(workspacesRoot: string,
  configDirectories: readonly string[] = claudeCodeConfigDirectories()): Promise<string[]> {
  const prefix = `${claudeProjectFolder(workspacesRoot)}-`;
  const orphaned: string[] = [];
  for (const directory of configDirectories) {
    for (const project of await projectFolders(directory)) {
      const name = project.slice(join(directory, "projects").length + 1);
      if (!name.startsWith(prefix)) continue;
      const workspace = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-repo$/u.exec(name.slice(prefix.length))?.[1];
      if (workspace !== undefined && !existsSync(join(workspacesRoot, workspace))) orphaned.push(project);
    }
  }
  return orphaned;
}
