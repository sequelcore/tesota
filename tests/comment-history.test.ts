import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ts as TypeScript } from "ts-morph";
import { expect, it } from "vitest";
import { isScriptPath, typescript } from "../src/typescript-source.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Parser-owned ranges exclude strings, templates and regular expressions, including test fixtures. */
function comments(path: string, text: string): readonly TypeScript.CommentRange[] {
  const ts = typescript();
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = new Map<number, TypeScript.CommentRange>();
  const visit = (node: TypeScript.Node): void => {
    if (ts.isJSDoc(node)) return;
    for (const position of [node.pos, node.end]) {
      for (const range of [...ts.getLeadingCommentRanges(text, position) ?? [], ...ts.getTrailingCommentRanges(text, position) ?? []]) {
        found.set(range.pos, range);
      }
    }
    node.getChildren(file).forEach(visit);
  };
  visit(file);
  return [...found.values()];
}

function citations(text: string): readonly string[] {
  const prose = text.replace(/\bTODO\(#\d+\)/gu, "")
    .replace(/\b[\w.-]+\/[\w.-]+#\d+\b/gu, (reference) => reference.toLowerCase().startsWith("sequelcore/tesota#") ? reference : "");
  return [...prose.matchAll(/#\d+\b|(?:https?:\/\/)?github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\b/giu)].map(([match]) => match);
}

/** Other source formats skip quoted literals before reading their comment delimiters. */
function proseRanges(path: string, text: string): readonly { readonly pos: number; readonly end: number }[] {
  if (isScriptPath(path)) return comments(path, text);
  const quoted = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/u.source;
  const comment = /\.(?:tla|cfg)$/u.test(path) ? /\(\*[\s\S]*?\*\)|\\\*[^\n]*/u.source
    : /\.dfy(?:\.gen)?$/u.test(path) ? /\/\*[\s\S]*?\*\/|\/\/[^\n]*/u.source
    : path.endsWith(".ps1") ? /<#[\s\S]*?#>|#[^\n]*/u.source
    : path.endsWith(".py") ? /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*/u.source : /#[^\n]*/u.source;
  const pattern = new RegExp(`(${comment})|${quoted}`, "gu");
  return [...text.matchAll(pattern)].filter((match) => match[1] !== undefined)
    .map((match) => ({ pos: match.index, end: match.index + match[0].length }));
}

function violations(path: string, text: string): readonly string[] {
  const ranges = proseRanges(path, text);
  return ranges.flatMap(({ pos, end }) => text.slice(pos, end).startsWith("//@") ? [] :
    citations(text.slice(pos, end)).map((issue) => `${path}:${text.slice(0, pos).split("\n").length}: ${issue}`));
}

it("rejects issue history in line, trailing and block comments, not source literals or specifications", () => {
  expect(violations("a.ts", '// see (#123)\nconst n = 1; // #456\n/* why\n * #789\n */')).toHaveLength(3);
  expect(violations("a.ts", 'const s = "// #123"; const t = `/* #456 */`; const r = /#789/;')).toEqual([]);
  expect(violations("a.ts", '// TODO(#123): finish this\n// Works around upstream/project#456.\n//@ ensures x === "#789"')).toEqual([]);
  expect(violations("a.ts", '// TODO(#123) and #456\n// upstream/project#789 and (#321)')).toHaveLength(2);
  expect(violations("a.ts", '// https://github.com/sequelcore/tesota/issues/123')).toHaveLength(1);
  expect(violations("a.ts", '// sequelcore/tesota#123')).toHaveLength(1);
  expect(violations("a.py", '"""Reason (#123)."""\n# see #456')).toHaveLength(2);
  expect(violations("a.yml", '# see (#123)\ncolor: "#123456"')).toHaveLength(1);
  expect(violations("a.tla", '(* Reason (#123). *)')).toHaveLength(1);
  expect(violations("a.tla", '\\* Reason (#123).')).toHaveLength(1);
  expect(violations("a.cfg", '\\* Reason (#123).')).toHaveLength(1);
  expect(violations("a.ps1", '<# Reason\n (#123) #>')).toHaveLength(1);
  expect(violations("a.dfy", '// Reason (#123).')).toHaveLength(1);
  expect(violations("a.yml", 'run: foo # see (#123)')).toHaveLength(1);
  expect(violations("a.ts", '// SequelCore/Tesota#123')).toHaveLength(1);
  expect(violations("a.ts", '// github.com/sequelcore/tesota/issues/123')).toHaveLength(1);
});

it("keeps issue history out of repository source comments", () => {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((path) => isScriptPath(path) || /\.(?:py|sh|ps1|ya?ml|toml|tla|cfg|dfy(?:\.gen)?)$/u.test(path) || path.endsWith("Dockerfile"))
    .filter((path) => existsSync(join(root, path)));
  expect(paths.flatMap((path) => violations(path, readFileSync(join(root, path), "utf8")))).toEqual([]);
});
