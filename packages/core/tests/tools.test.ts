import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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
    const longLine = shell.tool === "powershell" ? `[Console]::Write(('x' * ${3 * maxBytes}) + 'end')`
      : `printf '%${3 * maxBytes}s' '' | tr ' ' x; printf end`;

    test("output is UTF-8 and the tool says which shell it is", async () => {
      const cwd = folder();
      const spool = folder();
      const tool = shellTool(cwd, shell, () => spool);
      expect(tool.description).toContain(shell.label);
      const output = await run(tool, { command: say("ñandú ✓ 日本") });
      expect(output).toMatchObject({ isError: false });
      expect(output.text).toContain("ñandú ✓ 日本");
      expect(readdirSync(spool)).toEqual([]);
    });

    test("output past the limit goes to a file the model is told about, and the end stays in the reply", async () => {
      const cwd = folder();
      const spool = folder();
      const print = shell.tool === "powershell" ? "1..20000 | ForEach-Object { 'row-{0:D5}-padding-padding' -f $_ }"
        : "for i in $(seq 1 20000); do printf 'row-%05d-padding-padding\\n' $i; done";
      const tool = shellTool(cwd, shell, () => spool);
      const newline = shell.tool === "powershell" ? "\r\n" : "\n";
      const expected = Array.from({ length: 20000 }, (_, index) => `row-${String(index + 1).padStart(5, "0")}-padding-padding${newline}`).join("");
      const output = await tool.execute({ command: print }, new AbortController().signal, "call|first:1");
      expect(output.text).toContain("row-20000");
      const saved = readdirSync(spool);
      expect(saved).toHaveLength(1);
      expect(output.text).toContain(join(spool, saved[0] ?? ""));
      const firstPath = join(spool, saved[0] ?? "");
      expect(readFileSync(firstPath, "utf8")).toBe(expected);
      const second = await tool.execute({ command: print.replaceAll("padding-padding", "second-output") }, new AbortController().signal, "call|first:1");
      expect(readdirSync(spool)).toHaveLength(2);
      const secondPath = /Full output: (.+)\]/u.exec(second.text)?.[1] ?? "";
      expect(secondPath).not.toBe(firstPath);
      expect(readFileSync(secondPath, "utf8")).toBe(expected.replaceAll("padding-padding", "second-output"));
      expect(readFileSync(firstPath, "utf8")).toBe(expected);
      await tool.execute({ command: say("small") }, new AbortController().signal, "call|first:1");
      expect(readdirSync(spool)).toHaveLength(2);
      expect(readFileSync(firstPath, "utf8")).toBe(expected);
    });

    test("a single line past the capture window keeps its end without a newline", async () => {
      const spool = folder();
      const output = await run(shellTool(folder(), shell, () => spool), { command: longLine });
      expect(output.isError).toBe(false);
      expect(output.text.split("\n\n")[0]).toBe(`${"x".repeat(maxBytes - 3)}end`);
      const path = /Full output: (.+)\]/u.exec(output.text)?.[1] ?? "";
      expect(readFileSync(path, "utf8")).toBe(`${"x".repeat(3 * maxBytes)}end`);
    });

    test("an empty output file exists before the process starts and is removed when its output fits", async () => {
      const spool = folder();
      let path = "";
      const inspected: Shell = { ...shell, args: (command) => {
        const saved = readdirSync(spool);
        expect(saved).toHaveLength(1);
        path = join(spool, saved[0] ?? "");
        expect(readFileSync(path, "utf8")).toBe("");
        return shell.args(command);
      } };
      expect((await run(shellTool(folder(), inspected, () => spool), { command: say("small") })).isError).toBe(false);
      expect(existsSync(path)).toBe(false);
    });

    test("a spool write failure closes the file and keeps collecting the tail", async () => {
      const spool = folder();
      const tool = shellTool(folder(), shell, () => spool);
      let descriptor = -1;
      const write = spyOn(fs, "writeSync").mockImplementation((file) => { descriptor = file; throw new Error("disk full"); });
      try {
        const output = await run(tool, { command: longLine });
        expect(output.isError).toBe(false);
        expect(output.text.split("\n\n")[0]).toBe(`${"x".repeat(maxBytes - 3)}end`);
        expect(output.text).toContain("The full output could not be saved: disk full]");
        expect(output.text).not.toContain("Full output:");
        expect(() => fs.fstatSync(descriptor)).toThrow();
        expect(readdirSync(spool)).toEqual([]);
        expect(await run(tool, { command: say("small") })).toEqual({ text: "small", isError: false });
        expect(write).toHaveBeenCalledTimes(2);
        expect(readdirSync(spool)).toEqual([]);
      } finally {
        write.mockRestore();
      }
    });

    test("a spool file that cannot be created keeps the tail and reports the failure only for long output", async () => {
      const cwd = folder();
      const spool = join(cwd, "file.txt");
      writeFileSync(spool, "not a folder");
      const tool = shellTool(cwd, shell, () => spool);
      const output = await run(tool, { command: longLine });
      expect(output.isError).toBe(false);
      expect(output.text).toContain(`${"x".repeat(maxBytes - 3)}end`);
      expect(output.text).toContain("The full output could not be saved:");
      expect(output.text).not.toContain("Full output:");
      expect(readFileSync(spool, "utf8")).toBe("not a folder");
      const small = await run(tool, { command: say("small") });
      expect(small).toEqual({ text: "small", isError: false });
    });
  });
}

test.if(process.platform !== "win32")("bash is found on the PATH", () => {
  expect(bash("/bin/bash").args("true")).toEqual(["-c", "true"]);
  expect(existsSync(platformShell().executable)).toBe(true);
});
