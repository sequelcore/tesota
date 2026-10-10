import { expect, it } from "vitest";
import { commentOnlyLines } from "../src/typescript-source.js";

it("finds the lines that hold only comments as the parser reads them, never a //@ line or one inside a string", () => {
  const source = ["/* a block", "   plain middle line", "*/", "/** Doc. */", "export const s = `", "// inside a template", "`;",
    "const n = 1", "  * 2; // a product, not a comment", "//@ ensures \\result > 0", "// a note", ""].join("\n");
  expect([...commentOnlyLines("src/a.ts", source)]).toEqual([1, 2, 3, 4, 11]);
  expect([...commentOnlyLines("src/only.ts", "/* Nothing yet.\n * Later.\n */\n")]).toEqual([1, 2, 3]);
});
