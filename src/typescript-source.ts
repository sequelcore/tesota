import { createRequire } from "node:module";
import type { ts as TypeScript } from "ts-morph";

/**
 * JavaScript and TypeScript source read as their parser reads it, rather
 * than line by line: the parser LemmaScript uses, and which lines hold only
 * comments.
 */

let parser: typeof TypeScript | undefined;

/**
 * The TypeScript parser LemmaScript extracts contracts with, ts-morph's.
 * Loading it takes about 250 ms, so it loads on first use, at the gate,
 * rather than with the extension.
 */
export function typescript(): typeof TypeScript {
  parser ??= (createRequire(import.meta.url)("ts-morph") as { ts: typeof TypeScript }).ts;
  return parser;
}

/** Whether `path` is JavaScript or TypeScript source, which the parser reads. */
export function isScriptPath(path: string): boolean {
  return /\.[cm]?[jt]sx?$/u.test(path);
}

/**
 * The lines of `source` that hold only comments, as the parser reads it, so
 * a line inside a block comment counts whatever it starts with, and a line
 * inside a string or template never does; a `//@` line is an annotation,
 * never only a comment.
 */
export function commentOnlyLines(path: string, source: string): Set<number> {
  const ts = typescript();
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1;
  const code = new Set<number>();
  const visit = (node: TypeScript.Node): void => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(file);
    // A leaf with no text, such as an empty list or the end of the file, starts where its trivia does, so it marks no code.
    if (children.length === 0 && node.getWidth(file) > 0) {
      for (let line = lineOf(node.getStart(file)); line <= lineOf(node.getEnd()); line += 1) code.add(line);
    }
    children.forEach(visit);
  };
  visit(file);
  return new Set(source.split(/\r?\n/u).flatMap((text, index) => {
    const line = text.trim();
    return line !== "" && !line.startsWith("//@") && !code.has(index + 1) ? [index + 1] : [];
  }));
}
