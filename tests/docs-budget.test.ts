import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * How many words each kind of page may hold (#751): the prose a reader reads, outside code blocks, HTML and link
 * targets. A page that needs more is split, or its detail moves to the page that owns it.
 */
const BUDGETS: readonly (readonly [RegExp, number])[] = [
  [/^README\.md$/u, 500],
  [/^ROADMAP\.md$/u, 400],
  [/^DESIGN\.md$/u, 1400],
  [/^docs\/README\.md$/u, 250],
  [/^docs\/get-started\//u, 450],
  [/^docs\/guides\//u, 700],
  [/^docs\/concepts\//u, 1200],
  [/^docs\/reference\//u, 1200],
  [/^docs\/development\.md$/u, 1500],
];
/** The receipt's format is a specification, read field by field rather than through. */
const EXEMPT = new Set(["docs/receipt-v2.md"]);

/** The words a reader reads in a Markdown page: no code, fenced or inline, HTML, link targets or table rules. */
export function proseWords(markdown: string): number {
  const prose = markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "")
    .replace(/`[^`\n]+`/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\]\([^)]*\)/gu, "]")
    .replace(/^\|?[\s:|-]+\|?$/gmu, "")
    .replace(/[#>*_`|[\]-]/gu, " ");
  return prose.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function pages(): string[] {
  const docs = (folder: string): string[] => readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? docs(join(folder, entry.name)) : entry.name.endsWith(".md") ? [join(folder, entry.name)] : []);
  return ["README.md", "ROADMAP.md", "DESIGN.md", ...docs("docs")].map((path) => relative(root, join(root, path)).replaceAll("\\", "/"));
}

it("counts the prose a reader reads, not code, HTML or link targets", () => {
  expect(proseWords("One two.\n\n```sh\nnot counted here\n```\n\n<picture><img alt='not counted'></picture> [three](https://x.y/z)")).toBe(3);
  expect(proseWords("| A | B |\n| --- | --- |\n| four | five |")).toBe(4);
  expect(proseWords("Run `tesota doctor --json` now.")).toBe(2);
});

it("keeps every page within the budget for its kind", () => {
  const over = pages().filter((page) => !EXEMPT.has(page)).flatMap((page) => {
    const budget = BUDGETS.find(([pattern]) => pattern.test(page))?.[1];
    if (budget === undefined) return [`${page}: no budget for this kind of page`];
    const words = proseWords(readFileSync(join(root, page), "utf8"));
    return words > budget ? [`${page}: ${words} words, budget ${budget}`] : [];
  });
  expect(over).toEqual([]);
});
