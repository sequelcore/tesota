import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

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

/** Every file's imports from `effect`: the module each names, `effect/Stream` as `Stream`, and `{ Effect, Option }` from the root as both. */
function effectImports(): { file: string; module: string }[] {
  return [join(root, "src"), join(root, "packages", "core", "src")].flatMap(sources).flatMap((file) => {
    const at = relative(root, file).replaceAll("\\", "/");
    return [...readFileSync(file, "utf8").matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"effect(?:\/([^"]+))?"/gu)]
      .flatMap(([, names, path]) => path !== undefined ? [{ file: at, module: path }]
        : (names ?? "").split(",").map((name) => name.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0] ?? "").filter((name) => name !== "")
          .map((module) => ({ file: at, module })));
  });
}

test("Tesota uses only Effect's stable core modules, never one tagged unstable or experimental, nor a submodule", () => {
  // Effect 4 tags each module's stability; an unstable or experimental one may change in a patch release (docs/development.md).
  const dist = join(dirname(createRequire(import.meta.url).resolve("effect/package.json")), "dist");
  const stability = (module: string): string => {
    try { return /@stability (\w+)/u.exec(readFileSync(join(dist, `${module}.d.ts`), "utf8"))?.[1] ?? "untagged"; }
    catch { return "not a core module"; }
  };
  const imports = effectImports();
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.map((each) => ({ ...each, stability: stability(each.module) })).filter((each) => each.stability !== "stable")).toEqual([]);
});
