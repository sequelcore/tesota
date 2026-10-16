import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToolPath } from "../src/paths.ts";
import type { EngineTool } from "../src/tool.ts";
import { editTool } from "../src/tools/edit.ts";
import { byteOrderMark, readTool } from "../src/tools/read.ts";
import { bash, platformShell, powershell, type Shell, shellTool } from "../src/tools/shell.ts";
import { keepHead, keepTail, maxBytes } from "../src/truncate.ts";

/** What only `@tesota/core`'s tools promise; the loop tests compare the shared behavior with Pi. */

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 3 }); });
const folder = (): string => {
  const created = mkdtempSync(join(tmpdir(), "tesota-core-tools-"));
  folders.push(created);
  return created;
};
const run = (tool: EngineTool, args: unknown, signal = new AbortController().signal) => tool.execute(args as never, signal, "call");

describe("paths", () => {
  test.if(process.platform === "win32")("a Git Bash path is refused on Windows, with its Windows spelling", () => {
    expect(() => resolveToolPath("C:\\work", "/c/Users/me")).toThrow('"C:/Users/me"');
  });
  test("a relative path resolves against the session's folder, an absolute one stays", () => {
    const cwd = folder();
    expect(resolveToolPath(cwd, "a/b.txt")).toBe(join(cwd, "a", "b.txt"));
    expect(resolveToolPath(cwd, join(cwd, "x.txt"))).toBe(join(cwd, "x.txt"));
  });
});

describe("truncation", () => {
  test("the head and the tail keep whole lines within the limits", () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);
    expect(keepHead(lines)).toMatchObject({ lines: 2000, total: 3000, truncated: true });
    expect(keepTail(lines).text.split("\n").at(-1)).toBe("line 3000");
    expect(keepHead(["short"])).toMatchObject({ text: "short", truncated: false });
  });
  test("a line longer than the byte limit is cut without splitting a character", () => {
    const long = "é".repeat(maxBytes);
    const head = keepHead([long]);
    expect(Buffer.byteLength(head.text, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(head.text).not.toContain("\uFFFD");
    expect(keepTail([long]).text).not.toContain("\uFFFD");
  });
});

describe("edit", () => {
  test("a byte-order mark stays, and overlapping or unchanged edits are refused", async () => {
    const cwd = folder();
    const file = join(cwd, "f.txt");
    writeFileSync(file, `${byteOrderMark}abc def\n`);
    expect((await run(editTool(cwd), { path: "f.txt", edits: [{ oldText: "abc", newText: "xyz" }] })).isError).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(`${byteOrderMark}xyz def\n`);
    const overlapping = await run(editTool(cwd), { path: "f.txt", edits: [{ oldText: "xyz d", newText: "1" }, { oldText: "z def", newText: "2" }] });
    expect(overlapping).toMatchObject({ isError: true });
    expect(overlapping.text).toContain("overlaps");
    expect((await run(editTool(cwd), { path: "f.txt", edits: [{ oldText: "def", newText: "def" }] })).isError).toBe(true);
    expect((await run(editTool(cwd), { path: "f.txt", edits: [] })).isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`${byteOrderMark}xyz def\n`);
  });
});

describe("read", () => {
  test("an offset past the end fails and names the file's length", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "two.txt"), "a\nb\n");
    await expect(run(readTool(cwd), { path: "two.txt", offset: 5 })).rejects.toThrow("2 lines");
  });
});

/** Both PowerShells where Windows has them; bash elsewhere. */
function shells(): Shell[] {
  if (process.platform !== "win32") return [platformShell()];
  const windows = powershell(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), 5);
  const pwsh = Bun.which("pwsh");
  return pwsh === null ? [windows] : [windows, powershell(pwsh, 7)];
}

for (const shell of shells()) {
  describe(shell.label, () => {
    const say = (text: string) => shell.tool === "powershell" ? `Write-Output '${text}'` : `echo '${text}'`;

    test("output is UTF-8 and the tool says which shell it is", async () => {
      const cwd = folder();
      const tool = shellTool(cwd, shell, () => cwd);
      expect(tool.description).toContain(shell.label);
      const output = await run(tool, { command: say("ñandú ✓ 日本") });
      expect(output).toMatchObject({ isError: false });
      expect(output.text).toContain("ñandú ✓ 日本");
    });

    test("output past the limit goes to a file the model is told about, and the end stays in the reply", async () => {
      const cwd = folder();
      const spool = folder();
      const print = shell.tool === "powershell" ? "1..20000 | ForEach-Object { 'row-{0:D5}-padding-padding' -f $_ }"
        : "for i in $(seq 1 20000); do printf 'row-%05d-padding-padding\\n' $i; done";
      const output = await run(shellTool(cwd, shell, () => spool), { command: print });
      expect(output.text).toContain("row-20000");
      const saved = readdirSync(spool);
      expect(saved).toHaveLength(1);
      expect(output.text).toContain(join(spool, saved[0] ?? ""));
      expect(readFileSync(join(spool, saved[0] ?? ""), "utf8")).toContain("row-00001");
    });
  });
}

test.if(process.platform !== "win32")("bash is found on the PATH", () => {
  expect(bash("/bin/bash").args("true")).toEqual(["-c", "true"]);
  expect(existsSync(platformShell().executable)).toBe(true);
});
