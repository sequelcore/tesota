import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DiffView, parseUnifiedDiff } from "../src/tesota-shell-diff.js";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";

// Fixtures in git's unified diff format, as `git diff --no-renames --no-color` writes it.
const modified = [
  "diff --git a/src/price.ts b/src/price.ts",
  "index 1111111..2222222 100644",
  "--- a/src/price.ts",
  "+++ b/src/price.ts",
  "@@ -1,4 +1,4 @@",
  " export function total(amount: number): number {",
  "-  return amount >= 100 ? amount * 0.9 : amount;",
  "+  return amount > 100 ? amount * 0.9 : amount;",
  " }",
  " ",
  "@@ -20 +20,2 @@ export const rate = 0.9;",
  "-const old = 1;",
  "+const next = 2;",
  "+const more = 3;",
].join("\n");

it("reads each file's lines with old and new line numbers, across hunks", () => {
  const [file] = parseUnifiedDiff(modified);
  expect(file).toMatchObject({ path: "src/price.ts", status: "modified", binary: false, added: 3, removed: 2 });
  expect(file?.hunks.map((hunk) => hunk.header)).toEqual(["@@ -1,4 +1,4 @@", "@@ -20 +20,2 @@ export const rate = 0.9;"]);
  expect(file?.hunks[0]?.lines).toEqual([
    { kind: "context", oldLine: 1, newLine: 1, text: "export function total(amount: number): number {" },
    { kind: "removed", oldLine: 2, text: "  return amount >= 100 ? amount * 0.9 : amount;" },
    { kind: "added", newLine: 2, text: "  return amount > 100 ? amount * 0.9 : amount;" },
    { kind: "context", oldLine: 3, newLine: 3, text: "}" },
    { kind: "context", oldLine: 4, newLine: 4, text: "" },
  ]);
  expect(file?.hunks[1]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
    ["removed", 20, undefined], ["added", undefined, 20], ["added", undefined, 21]]);
});

it("reads added, deleted and binary files, a missing final newline, and quoted paths", () => {
  const files = parseUnifiedDiff([
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const a = 1;",
    "+export const b = 2;",
    "\\ No newline at end of file",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "index 0000000..5555555",
    "Binary files /dev/null and b/logo.png differ",
    "diff --git \"a/docs/caf\\303\\251 notes.md\" \"b/docs/caf\\303\\251 notes.md\"",
    "index 6666666..7777777 100644",
    "--- \"a/docs/caf\\303\\251 notes.md\"",
    "+++ \"b/docs/caf\\303\\251 notes.md\"",
    "@@ -1 +1 @@",
    "-a\\tb",
    "+a b",
  ].join("\n"));
  expect(files.map((file) => [file.path, file.status, file.binary, file.added, file.removed])).toEqual([
    ["src/new.ts", "added", false, 2, 0],
    ["old.txt", "deleted", false, 0, 1],
    ["logo.png", "added", true, 0, 0],
    ["docs/café notes.md", "modified", false, 1, 1],
  ]);
  expect(files[0]?.hunks[0]?.lines.at(-1)).toEqual({ kind: "added", newLine: 2, text: "export const b = 2;" });
  expect(files[3]?.hunks[0]?.lines[0]?.text).toBe("a\\tb");
});

it("reads nothing from an empty diff", () => {
  expect(parseUnifiedDiff("")).toEqual([]);
});

describe("the diff view", () => {
  const theme = tesotaShellTheme("tesota-dark");
  const addedTint = "\x1b[48;2;29;51;36m";

  it("summarizes the files, numbers each line and tints added and removed rows across the width", () => {
    const view = new DiffView(theme);
    view.setDiff(modified);
    const lines = view.render(60);
    const text = lines.map((line) => stripTerminalSequences(line));
    expect(text[0]).toContain("1 file changed +3 -2");
    expect(text[1]).toMatch(/^ src\/price\.ts +\+3 -2$/u);
    expect(text).toContain(" src/price.ts");
    expect(text.some((line) => line.startsWith("  2 + ") && line.includes("amount > 100"))).toBe(true);
    expect(text.some((line) => line.startsWith("  2 - ") && line.includes("amount >= 100"))).toBe(true);
    const added = lines.find((line) => stripTerminalSequences(line).startsWith("  2 + "));
    expect(added?.startsWith(addedTint)).toBe(true);
    expect(visibleWidth(added ?? "")).toBe(60);
    expect(text.some((line) => line.trim() === "⋯")).toBe(true);
  });

  it("never passes a terminal control sequence from file content to the terminal", () => {
    const view = new DiffView(theme);
    view.setDiff("diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+hello\x1b]0;owned\x07\x1b[2J");
    const rendered = view.render(60).join("\n");
    expect(rendered).not.toContain("\x1b]0;owned");
    expect(rendered).not.toContain("\x1b[2J");
  });

  it("draws a diff once per width, and again only when the diff or the width changes", () => {
    const view = new DiffView(theme);
    view.setDiff(modified);
    const first = view.render(60);
    // Every frame asks again; highlighting a large diff each time slowed the whole shell (findings, 2026-09-27).
    expect(view.render(60)).toBe(first);
    expect(view.render(70)).not.toBe(first);
    view.setDiff(modified);
    expect(view.render(70)).not.toBe(first);
  });
});
