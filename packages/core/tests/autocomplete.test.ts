import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FileAutocompleteProvider } from "../src/shell/autocomplete.ts";

const folder = (): string => mkdtempSync(join(tmpdir(), "tesota-core-completion-"));
const suggest = (provider: FileAutocompleteProvider, text: string, signal = new AbortController().signal) =>
  provider.getSuggestions([text], 0, text.length, { signal });
const git = (cwd: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
};

describe("file autocomplete", () => {
  test("lists tracked and untracked files, excludes ignored files, and ranks fuzzy matches", async () => {
    const cwd = folder();
    git(cwd, "init");
    writeFileSync(join(cwd, ".gitignore"), "ignored-notes.md\n");
    writeFileSync(join(cwd, "tracked-notes.md"), "tracked\n");
    git(cwd, "add", "tracked-notes.md");
    writeFileSync(join(cwd, "untracked-notes.md"), "new\n");
    writeFileSync(join(cwd, "ignored-notes.md"), "ignored\n");
    const provider = new FileAutocompleteProvider([], cwd);
    const result = await suggest(provider, "read @ntmd");
    expect(result?.prefix).toBe("@ntmd");
    expect(result?.items.map((item) => item.value)).toEqual(["@tracked-notes.md", "@untracked-notes.md"]);
    const subfolder = join(cwd, "nested");
    mkdirSync(subfolder);
    writeFileSync(join(subfolder, "local-notes.md"), "local\n");
    expect((await suggest(new FileAutocompleteProvider([], subfolder), "@notes"))?.items.map((item) => item.value))
      .toEqual(["@local-notes.md"]);
  });

  test("outside Git, respects ignores and includes hidden files except .git", async () => {
    const cwd = folder();
    for (const name of ["notes", "node_modules", ".hidden", ".git"]) {
      mkdirSync(join(cwd, name));
      writeFileSync(join(cwd, name, "notes.md"), "notes\n");
    }
    writeFileSync(join(cwd, "notes.md"), "notes\n");
    writeFileSync(join(cwd, ".ignore"), "node_modules/\n");
    const result = await suggest(new FileAutocompleteProvider([], cwd), "@notes");
    expect(result?.items.map((item) => item.value).sort()).toEqual(["@.hidden/notes.md", "@notes.md", "@notes/", "@notes/notes.md"]);
  });

  test("inserts quoted files and folders using pi-tui's completion semantics", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "my notes.md"), "notes\n");
    mkdirSync(join(cwd, "my folder"));
    writeFileSync(join(cwd, "my folder", "file.md"), "notes\n");
    const provider = new FileAutocompleteProvider([], cwd);
    for (const [text, value, label, line, col] of [
      ["read @notes", '@"my notes.md"', "my notes.md", 'read @"my notes.md" ', 20],
      ['read @"my n', '@"my notes.md"', "my notes.md", 'read @"my notes.md" ', 20],
      ["read @folder", '@"my folder/"', "my folder/", 'read @"my folder/"', 17],
    ] as const) {
      const result = await suggest(provider, text);
      const item = result?.items.find((each) => each.value === value);
      expect(item).toMatchObject({ value, label });
      if (item === undefined || result === null) throw new Error("missing completion");
      expect(provider.applyCompletion([text], 0, text.length, item, result.prefix))
        .toEqual({ lines: [line], cursorLine: 0, cursorCol: col });
    }
  });

  test("delegates slash commands, command arguments and path prefixes", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "local.md"), "local\n");
    const args: AutocompleteItem[] = [{ value: "dark", label: "dark" }];
    const provider = new FileAutocompleteProvider([{ name: "theme", description: "Choose a theme", getArgumentCompletions: () => args }], cwd);
    const commands = await suggest(provider, "/th");
    expect(commands).toEqual({ prefix: "/th", items: [{ value: "theme", label: "theme", description: "Choose a theme" }] });
    expect(await suggest(provider, "/theme d")).toEqual({ prefix: "d", items: args });
    expect((await suggest(provider, "./loc"))?.items.map((item) => item.value)).toEqual(["./local.md"]);
    writeFileSync(join(homedir(), "home-notes.md"), "home\n");
    expect((await suggest(provider, "~/home-no"))?.items.map((item) => item.value)).toEqual(["~/home-notes.md"]);
    expect(provider.applyCompletion(["/th"], 0, 3, { value: "theme", label: "theme" }, "/th"))
      .toEqual({ lines: ["/theme "], cursorLine: 0, cursorCol: 7 });
  });

  test("caches a folder's list and refreshes it after three seconds", async () => {
    const cwd = folder();
    git(cwd, "init");
    writeFileSync(join(cwd, "first-notes.md"), "first\n");
    const provider = new FileAutocompleteProvider([], cwd);
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect((await suggest(provider, "@notes"))?.items.map((item) => item.value)).toEqual(["@first-notes.md"]);
      writeFileSync(join(cwd, "new-notes.md"), "new\n");
      expect((await suggest(provider, "@new"))).toBeNull();
      now += 3_001;
      expect((await suggest(provider, "@new"))?.items.map((item) => item.value)).toEqual(["@new-notes.md"]);
    } finally { clock.mockRestore(); }
  });

  test("a cancelled keystroke leaves the pending list available to the next query", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "notes.md"), "notes\n");
    const provider = new FileAutocompleteProvider([], cwd);
    const controller = new AbortController();
    const cancelled = suggest(provider, "@notes", controller.signal);
    const next = suggest(provider, "@notes");
    controller.abort();
    expect(await cancelled).toBeNull();
    expect((await next)?.items.map((item) => item.value)).toEqual(["@notes.md"]);
    expect(await suggest(provider, "@notes", controller.signal)).toBeNull();
  });
});
