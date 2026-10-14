import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { grammarCommentLines, hasGrammar } from "../src/grammar-source.js";

it("finds the lines that hold only comments as each grammar reads its file, never one inside a string", async () => {
  const python = ["#!/usr/bin/env python3", "# a note", "x = 1  # trailing", "s = \"\"\"", "# inside a string", "\"\"\"",
    "y = (1,", "     # inside parentheses", "     2)", ""].join("\n");
  expect([...await grammarCommentLines("tool.py", python)]).toEqual([1, 2, 8]);
  const go = ["package price", "", "// Total adds.", "/* plain", "   middle line", "*/", "var raw = `", "// inside a raw string",
    "`", "func set(p *int) {", "\t*p = 2 /* trailing */", "}", ""].join("\r\n");
  expect([...await grammarCommentLines("price.go", go)]).toEqual([3, 4, 5, 6]);
});

it("finds no comment line in a file that does not parse, or in a language no grammar reads", async () => {
  expect([...await grammarCommentLines("open.py", "x = \"\"\"\n# open\n")]).toEqual([]);
  expect([...await grammarCommentLines("price.rs", "// a note\n")]).toEqual([]);
  expect([hasGrammar("a/b.py"), hasGrammar("b_test.go"), hasGrammar("c.rs"), hasGrammar("Makefile"), hasGrammar("d.py/e")])
    .toEqual([true, true, false, false, false]);
});

it("ships each grammar as the package package.json pins publishes it", () => {
  const require = createRequire(import.meta.url);
  for (const name of ["tree-sitter-go", "tree-sitter-python"]) {
    expect(readFileSync(`grammars/${name}.wasm`).equals(readFileSync(require.resolve(`${name}/${name}.wasm`))), name).toBe(true);
  }
});
