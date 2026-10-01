import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { claudeProjectFolder, orphanedWorkspaceTranscripts, removeClaudeTranscripts } from "../src/claude-code-transcripts.js";
import { formatPrunePlan, planWorkspacePrune, removeWorkspaces } from "../src/workspace-prune.js";

/**
 * A closed session's Claude Code conversations go with it, by the ids it
 * recorded (#226): the operator's own conversations in the same project
 * folder stay, and a folder is removed only when these conversations emptied it.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ours = "2b664096-24f6-444e-91a5-59ff34746f34";
const theirs = "9f1c1a52-0a31-4c5e-9d8b-6a3c3a1b2c3d";

function claudeFolder(): { root: string; config: string; project: (name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "tesota-claude-transcripts-"));
  roots.push(root);
  const config = join(root, ".claude");
  const project = (name: string): string => { const path = join(config, "projects", name); mkdirSync(path, { recursive: true }); return path; };
  return { root, config, project };
}

it("names a project folder as Claude Code does: every character but a letter or digit becomes -", () => {
  expect(claudeProjectFolder("C:\\Users\\R3XED\\.tesota\\workspaces\\6debefd1-972c-431d-aa16-010e723ed98c\\repo"))
    .toBe(process.platform === "win32" ? "C--Users-R3XED--tesota-workspaces-6debefd1-972c-431d-aa16-010e723ed98c-repo"
      : claudeProjectFolder("C:\\Users\\R3XED\\.tesota\\workspaces\\6debefd1-972c-431d-aa16-010e723ed98c\\repo"));
});

it("removes only the recorded conversations, keeps the operator's own, and a folder only when it emptied it", async () => {
  const { config, project } = claudeFolder();
  const shared = project("C--Proyectos-repo");
  writeFileSync(join(shared, `${ours}.jsonl`), "{}\n");
  mkdirSync(join(shared, ours));
  writeFileSync(join(shared, `${theirs}.jsonl`), "{}\n");
  const alone = project("C--Users-me--tesota-workspaces-x-repo");
  writeFileSync(join(alone, `${ours}.jsonl`), "{}\n");
  const empty = project("C--their-empty-project");
  expect(await removeClaudeTranscripts([ours, "../escape"], [config])).toBe(3);
  expect(existsSync(join(shared, `${ours}.jsonl`))).toBe(false);
  expect(existsSync(join(shared, ours))).toBe(false);
  expect(existsSync(join(shared, `${theirs}.jsonl`))).toBe(true);
  expect(existsSync(alone)).toBe(false);
  // An empty folder these conversations did not empty is not Tesota's to remove.
  expect(existsSync(empty)).toBe(true);
});

it("lets prune remove Claude Code folders of isolated workspaces that no longer exist, and only those", async () => {
  const { root, config, project } = claudeFolder();
  const workspaces = join(root, "workspaces");
  const live = "4863d403-449c-489b-a147-f96c359d6464";
  const gone = "6debefd1-972c-431d-aa16-010e723ed98c";
  mkdirSync(join(workspaces, live, "repo"), { recursive: true });
  const kept = project(claudeProjectFolder(join(workspaces, live, "repo")));
  const orphan = project(claudeProjectFolder(join(workspaces, gone, "repo")));
  const operators = project(claudeProjectFolder(join(root, "my-project")));
  for (const folder of [kept, orphan, operators]) writeFileSync(join(folder, `${theirs}.jsonl`), "{}\n");
  expect(await orphanedWorkspaceTranscripts(workspaces, [config])).toEqual([orphan]);
  const plan = await planWorkspacePrune(workspaces, join(root, "stores"), join(root, "sources"), join(root, "source-sessions"), [config]);
  expect(plan.transcripts).toEqual([orphan]);
  expect(formatPrunePlan(plan)).toContain("Claude Code conversations of a workspace that no longer exists");
  await removeWorkspaces({ ...plan, remove: [] });
  expect([existsSync(kept), existsSync(orphan), existsSync(operators)]).toEqual([true, false, true]);
  // Without Claude Code's folders named, prune reads none of them.
  expect((await planWorkspacePrune(workspaces, join(root, "stores"), join(root, "sources"), join(root, "source-sessions"))).transcripts)
    .toEqual([]);
});
