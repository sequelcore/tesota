import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/** Bun macro: bundle the same model rules for file://, also when compiling a release. */
export function modelHtmlBundle(): string {
  const license = readFileSync(new URL("../../../node_modules/cytoscape/LICENSE", import.meta.url), "utf8");
  return `/* Cytoscape.js 3.33.1 (MIT)\n${license}*/\n` + execFileSync("bun", ["build", fileURLToPath(new URL("../../../src/model-html-page.ts", import.meta.url)),
    "--target=browser", "--format=iife", "--minify", "--define", "process.pid=0"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .replace(/<\/script/giu, "<\\/script");
}
