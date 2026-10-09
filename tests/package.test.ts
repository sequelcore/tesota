import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { expect, it } from "vitest";

// Lists what `npm pack` would put in the package, from the built launcher; `bun run test` builds it first.
function packedFiles(): Set<string> {
  const node = dirname(process.execPath);
  const npm = [join(node, "node_modules", "npm", "bin", "npm-cli.js"), join(node, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
    .find((path) => existsSync(path));
  if (npm === undefined) throw new Error(`npm is not installed beside ${process.execPath}`);
  const result = spawnSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
  const [pack] = JSON.parse(result.stdout) as [{ files: { path: string }[] }];
  return new Set(pack.files.map((file) => file.path.replaceAll("\\", "/")));
}

/** The packed files `entry` reaches through relative imports; a `.js` import names its `.ts` source in `src`. */
function reached(entry: string, packed: ReadonlySet<string>, found = new Set<string>()): Set<string> {
  found.add(entry);
  for (const [, specifier] of readFileSync(entry, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/gu)) {
    const target = posix.join(posix.dirname(entry), specifier ?? "");
    const file = entry.startsWith("src/") ? target.replace(/\.js$/u, ".ts") : target;
    expect(packed, `${entry} imports ${specifier}`).toContain(file);
    if (!found.has(file)) reached(file, packed, found);
  }
  return found;
}

it("packs the extension, the launcher and what they import, the themes and the notices, and nothing else", () => {
  const packed = packedFiles();
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { pi: { extensions: string[] }; bin: { tesota: string } };
  const code = new Set([...manifest.pi.extensions, manifest.bin.tesota].flatMap((entry) => [...reached(posix.normalize(entry), packed)]));
  const rest = [...packed].filter((file) => !code.has(file));
  expect(rest.filter((file) => !/^(themes|terminal-schemes)\//u.test(file)).sort())
    .toEqual(["LICENSE", "NOTICE", "README.md", "package.json"]);
  expect(rest.filter((file) => file.startsWith("themes/")).length).toBeGreaterThan(0);
  expect(rest.filter((file) => file.startsWith("terminal-schemes/")).length).toBeGreaterThan(0);
}, 60_000);
