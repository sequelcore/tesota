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
 * rather than with the extension. Bun has `require` in a module, and only a
 * `require` of the package by name is one its compiler embeds in a binary
 * (#472); Node, which runs the tests, has `createRequire` instead.
 */
export function typescript(): typeof TypeScript {
  parser ??= ((typeof require === "function" ? require("ts-morph") : createRequire(import.meta.url)("ts-morph")) as
    { ts: typeof TypeScript }).ts;
  return parser;
}

/** Whether `path` is JavaScript or TypeScript source, which the parser reads. */
export function isScriptPath(path: string): boolean {
  return /\.[cm]?[jt]sx?$/u.test(path);
}

/**
 * The lines of `source` that a call whose callee names an identifier
 * `callee` matches spans, such as an assertion's: `expect(x)` and the
 * `.toEqual([...])` of it across lines alike.
 */
export function callLines(path: string, source: string, callee: RegExp): Set<number> {
  const ts = typescript();
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1;
  const names = (node: TypeScript.Node): boolean =>
    ts.isIdentifier(node) ? callee.test(node.text) : ts.forEachChild(node, names) === true;
  const lines = new Set<number>();
  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node) && names(node.expression)) {
      for (let line = lineOf(node.getStart(file)); line <= lineOf(node.getEnd()); line += 1) lines.add(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
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
