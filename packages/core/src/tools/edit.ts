import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { editsApply } from "../edit-rule.ts";
import { resolveToolPath } from "../paths.ts";
import type { EngineTool } from "../tool.ts";
import { byteOrderMark } from "./read.ts";

const parameters = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text to replace. It must occur exactly once in the file." }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  }), { description: "Edits, each matched against the file as it was before any of them" }),
});

interface Located { readonly matches: number; readonly start: number; readonly end: number; readonly changes: boolean }

const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/** Where `oldText` occurs in `text`, counting every occurrence, even overlapping ones; an empty text never matches. */
function locate(text: string, oldText: string, newText: string): Located {
  let matches = 0;
  let first = -1;
  for (let at = oldText === "" ? -1 : text.indexOf(oldText); at !== -1; at = text.indexOf(oldText, at + 1)) {
    if (matches === 0) first = at;
    matches++;
  }
  return { matches, start: Math.max(first, 0), end: Math.max(first, 0) + (first === -1 ? 0 : oldText.length), changes: oldText !== newText };
}

/** Why the edits cannot be applied, naming the first edit at fault. */
function problem(located: readonly Located[]): string {
  if (located.length === 0) return "No edits were given.";
  for (const [index, edit] of located.entries()) {
    const which = `Edit ${index + 1}`;
    if (edit.matches === 0) return `${which}: its oldText does not occur in the file; copy it exactly, whitespace included.`;
    if (edit.matches > 1) return `${which}: its oldText occurs ${edit.matches} times; include more of the surrounding text so it occurs once.`;
    if (!edit.changes) return `${which}: its newText is the same as its oldText.`;
  }
  const overlapping = located.findIndex((edit, index) => located.some((other, at) =>
    at !== index && !(edit.end <= other.start || other.end <= edit.start)));
  return `Edit ${overlapping + 1} overlaps another edit; combine them into one.`;
}

/**
 * Replaces exact text in a file. Every edit must match exactly once in the
 * file as it was, change something and not overlap another; otherwise
 * nothing is written. Line endings and a byte-order mark are kept. There
 * is no fuzzy matching: a near miss fails, so the agent sees it.
 */
export function editTool(cwd: string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "edit",
    access: "write",
    description: "Edit a file by replacing exact text. Each oldText must occur exactly once in the file; "
      + "all edits apply together, or none do.",
    parameters,
    async execute({ path, edits }) {
      const file = resolveToolPath(cwd, path);
      const raw = await readFile(file, "utf8");
      const bom = raw.startsWith(byteOrderMark);
      const body = bom ? raw.slice(1) : raw;
      const text = lf(body);
      const located = edits.map((edit) => locate(text, lf(edit.oldText), lf(edit.newText)));
      if (!editsApply(located.map((edit) => edit.matches), located.map((edit) => edit.start), located.map((edit) => edit.end),
        located.map((edit) => edit.changes))) {
        return { text: `${problem(located)} The file was not changed.`, isError: true };
      }
      let edited = text;
      for (const index of located.map((_, at) => at).sort((a, b) => (located[b]?.start ?? 0) - (located[a]?.start ?? 0))) {
        const edit = located[index];
        const replacement = lf(edits[index]?.newText ?? "");
        if (edit !== undefined) edited = edited.slice(0, edit.start) + replacement + edited.slice(edit.end);
      }
      const restored = body.includes("\r\n") ? edited.replace(/\n/g, "\r\n") : edited;
      await writeFile(file, (bom ? byteOrderMark : "") + restored, "utf8");
      return { text: `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${path}.`, isError: false };
    },
  };
  return tool as EngineTool;
}
