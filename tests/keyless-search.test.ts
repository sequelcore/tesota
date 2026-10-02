import { expect, it } from "vitest";
import { exaResults, parallelResults, SNIPPET_LIMIT } from "../src/integrations/keyless-search.js";

it("reads Exa's results from its text, keeping only pages and a short snippet", () => {
  const text = "Title: Bun v1.4.2 | Bun Blog\nURL: https://bun.com/blog/bun-v1.4.2\nPublished: 2026-09-05T05:39:32.000Z\n" +
    `Author: N/A\nHighlights:\nBun v1.4.2\n\nThis release fixes two regressions.\n${"x".repeat(400)}\n\n---\n\n` +
    "Title: \nURL: https://github.com/oven-sh/bun/releases\nPublished: N/A\nAuthor: oven-sh\nHighlights:\n- Bun v1.4\n\n---\n\n" +
    "Title: Not a page\nURL: javascript:alert(1)\nHighlights:\nx";
  const results = exaResults(text);
  expect(results.map((result) => [result.title, result.url])).toEqual([["Bun v1.4.2 | Bun Blog", "https://bun.com/blog/bun-v1.4.2"],
    ["https://github.com/oven-sh/bun/releases", "https://github.com/oven-sh/bun/releases"]]);
  expect(results[0]?.snippet.startsWith("Bun v1.4.2 This release fixes two regressions.")).toBe(true);
  expect(results[0]?.snippet.length).toBe(SNIPPET_LIMIT + 1);
  expect(results[1]?.snippet).toBe("- Bun v1.4");
});

it("reads Parallel's results from its JSON, and refuses another shape", () => {
  const text = JSON.stringify({ search_id: "search_1", results: [
    { url: "https://bun.sh/blog", title: "Blog | Bun", publish_date: null, excerpts: ["Latest September 5, 2026", "Bun v1.4.2"] },
    { url: "ftp://files.example/", title: "Files", excerpts: [] },
    { url: "https://bun.com/docs", title: null, excerpts: null }] });
  expect(parallelResults(text)).toEqual([
    { title: "Blog | Bun", url: "https://bun.sh/blog", snippet: "Latest September 5, 2026 Bun v1.4.2" },
    { title: "https://bun.com/docs", url: "https://bun.com/docs", snippet: "" }]);
  expect(parallelResults("not json")).toBeUndefined();
  expect(parallelResults(JSON.stringify({ hits: [] }))).toBeUndefined();
});
