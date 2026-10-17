import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * What Tesota takes from Pi's packages (#463): model access from `pi-ai`, the
 * terminal from `pi-tui` and the MCP client from `pi-mcp` (#459), never Pi's
 * coding agent, whose extension API Tesota declares itself (`src/contract.ts`).
 * The evaluation keeps Pi until it runs on the engine (#464), so it is not
 * checked here.
 */
const root = join(import.meta.dir, "..", "..", "..");
const kept = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/pi-mcp"]);

/** Every TypeScript file under `folder`, outside dependencies. */
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("Tesota imports only pi-ai, pi-tui and pi-mcp of Pi's packages", () => {
  const imported = [join(root, "src"), join(root, "tests"), join(root, "packages", "core", "src"), join(root, "packages", "core", "tests")]
    .flatMap(sources).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/from "(@earendil-works\/[^"/]+(?:\/[^"]+)?)"/gu)]
      .map(([, specifier]) => ({ file: relative(root, file).replaceAll("\\", "/"), package: (specifier ?? "").split("/").slice(0, 2).join("/") })));
  expect(imported.length).toBeGreaterThan(0);
  expect(imported.filter((each) => !kept.has(each.package))).toEqual([]);
});
