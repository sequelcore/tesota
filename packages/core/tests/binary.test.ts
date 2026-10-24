import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { build } from "../scripts/build.ts";

/**
 * A binary verifies as the checkout does (#472): built as a release builds
 * it, and run from a folder outside the checkout, where no package or file of
 * the repository can be found.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

function folder(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const executable = (name: string): string => process.platform === "win32" ? `${name}.exe` : name;
const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;
const clamp = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
  "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
  "  if (value > high) return high;\n  return value;\n}\n";

test("the split engine bundle does not retain unused Effect APIs through the lazy gate", async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "main.ts")],
    target: "bun", format: "esm", splitting: true, minify: true });
  expect(result.success).toBe(true);
  const chunks = await Promise.all(result.outputs.map((output) => output.text()));
  // No consumer uses this API. Importing Effect's namespace dynamically makes Bun retain
  // its export table and otherwise-unused code in chunks shared with shell startup (#532).
  expect(chunks.join("\n")).not.toContain("annotateLogsScoped");
});

test("the engine's binary starts, and runs LemmaScript it embeds", () => {
  const binary = join(folder("tesota-core-binary-"), executable("tesota"));
  build(binary);
  const project = folder("tesota-core-binary-project-");
  const run = (...args: string[]) => spawnSync(binary, args, { cwd: project, encoding: "utf8" });
  expect(run("--version").stdout.trim()).toBe(manifest.version);
  writeFileSync(join(project, "clamp.ts"), clamp);
  const regen = run("__lsc", "regen", "--no-verify", "--backend=dafny", "clamp.ts");
  expect(regen.stderr).toBe("");
  expect(regen.stdout).toContain("clamp.dfy.gen");
}, 120_000);

test("the binary renders a captured graph through its disposable worker outside the checkout", () => {
  const binary = join(folder("tesota-graph-binary-"), executable("tesota"));
  build(binary);
  const project = folder("tesota-graph-project-");
  const dot = 'digraph {\n1 [label="/\\\\ pc = \\"idle\\""]\n}';
  writeFileSync(join(project, "reached.dot"), dot);
  writeFileSync(join(project, "graph.manifest.json"), JSON.stringify({ version: 1, status: "captured", exploration: "complete",
    artifacts: { dot: { file: "reached.dot", sha256: createHash("sha256").update(dot).digest("hex") } }, graph: { trace: [], violations: {} } }));
  const result = spawnSync(binary, ["graph", "--plain", join(project, "graph.manifest.json")], { cwd: project, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Reached 1; reported violating 0");
  expect(result.stdout).toContain("pc");
}, 120_000);

test("in a binary, the verifier reads TypeScript, Python and Go, and proves a contract", () => {
  const binary = join(folder("tesota-core-binary-"), executable("verifier"));
  build(binary, { entry: join(import.meta.dir, "binary-entry.ts") });
  const project = folder("tesota-core-binary-project-");
  writeFileSync(join(project, "clamp.ts"), clamp);
  const run = spawnSync(binary, [project], { cwd: project, encoding: "utf8" });
  expect(run.stderr).toBe("");
  const read = JSON.parse(run.stdout) as { typescript: number[]; python: number[]; go: number[]; proof: { outcome: string; files: string[] } };
  expect(read).toMatchObject({ typescript: [1], python: [1], go: [1] });
  expect(read).toMatchObject({ search: { isError: false, text: "clamp.ts:3:export function clamp(value: number, low: number, high: number): number {" } });
  expect(existsSync(join(process.env["TESOTA_ISOLATED"] ?? "", ".tesota", "ripgrep"))).toBe(true);
  expect(readdirSync(join(process.env["TESOTA_ISOLATED"] ?? "", ".tesota", "ripgrep"))).toHaveLength(1);
  if (dafny) expect(read.proof).toEqual({ outcome: "passed", files: ["clamp.ts", "clamp.dfy"] });
}, 300_000);
