import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { commentOnly } from "./verification/comment-line-rule.js";

/**
 * Source in a language a tree-sitter grammar reads, other than JavaScript and
 * TypeScript, which the TypeScript parser reads (`typescript-source.ts`).
 * Each language is a file extension, the grammar Tesota ships in `grammars/`,
 * copied from the grammar's package at the version `package.json` pins, and
 * the nodes the grammar calls comments.
 */
const grammars: Readonly<Record<string, { readonly file: string; readonly comments: readonly string[] }>> = {
  ".go": { file: "tree-sitter-go.wasm", comments: ["comment"] },
  ".py": { file: "tree-sitter-python.wasm", comments: ["comment"] },
};

function grammarOf(path: string): { readonly file: string; readonly comments: readonly string[] } | undefined {
  const extension = /\.[^./]+$/u.exec(path)?.[0];
  return extension === undefined || !Object.hasOwn(grammars, extension) ? undefined : grammars[extension];
}

/** Whether a grammar Tesota ships reads `path` (`grammarCommentLines`). */
export function hasGrammar(path: string): boolean {
  return grammarOf(path) !== undefined;
}

let ready: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();

/** The grammar in `file`, loaded once, with the runtime a parser needs, on first use, at the gate. */
async function language(file: string): Promise<Language> {
  ready ??= Parser.init();
  await ready;
  let loaded = languages.get(file);
  if (loaded === undefined) {
    loaded = Language.load(fileURLToPath(new URL(`../grammars/${file}`, import.meta.url)));
    languages.set(file, loaded);
  }
  return loaded;
}

/**
 * The lines of `source`, a file of `path`, that hold only comments as its
 * grammar reads it (`commentOnly`): a line inside a string never does, and a
 * file that does not parse has none. Numbered from 1, as Git's lines are; a
 * path no grammar reads has none.
 */
export async function grammarCommentLines(path: string, source: string): Promise<Set<number>> {
  const grammar = grammarOf(path);
  if (grammar === undefined) return new Set();
  const loaded = await language(grammar.file);
  const parser = new Parser();
  try {
    parser.setLanguage(loaded);
    const tree = parser.parse(source);
    if (tree === null) return new Set();
    try {
      const inComment = Array.from({ length: source.length }, () => false);
      for (const node of tree.rootNode.descendantsOfType([...grammar.comments])) inComment.fill(true, node.startIndex, node.endIndex);
      const found = new Set<number>();
      let start = 0;
      for (const [k, line] of source.split("\n").entries()) {
        // Character by UTF-16 unit, as tree-sitter indexes a JavaScript string.
        const blank = Array.from({ length: line.length }, (_, i) => /\s/u.test(line[i] ?? ""));
        if (commentOnly(!tree.rootNode.hasError, blank, inComment.slice(start, start + line.length))) found.add(k + 1);
        start += line.length + 1;
      }
      return found;
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
