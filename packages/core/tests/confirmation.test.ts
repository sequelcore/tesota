import { expect, test } from "bun:test";
import { confirmation } from "../src/shell/app.ts";

const reason = "The session is in ask.";

test("a shell command asks to run it, the command in its own block, clipped after twelve lines", () => {
  const long = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
  expect(confirmation({ name: "powershell", arguments: { command: "Get-ChildItem -Force" } }, reason)).toEqual({
    title: "Run a PowerShell command?", body: "Get-ChildItem -Force", note: "The session is in ask. Shift+Tab changes the mode." });
  const asked = confirmation({ name: "bash", arguments: { command: long } }, reason);
  expect(asked.title).toBe("Run a shell command?");
  expect(asked.body?.split("\n")).toHaveLength(13);
  expect(asked.body?.endsWith("line 12\n… 2 more lines")).toBe(true);
});

test("an edit shows what it replaces, and a write the file's start", () => {
  expect(confirmation({ name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "one", newText: "two" }] } }, reason))
    .toMatchObject({ title: "Edit src/a.ts?", body: "- one\n+ two" });
  expect(confirmation({ name: "write", arguments: { path: "notes.md", content: "# Notes\nmore\n" } }, reason))
    .toMatchObject({ title: "Write notes.md?", body: "# Notes\nmore" });
});

test("another tool is named with its arguments", () => {
  expect(confirmation({ name: "github_create_issue", arguments: { title: "Bug" } }, reason))
    .toMatchObject({ title: "Use github_create_issue?", body: "{\"title\":\"Bug\"}" });
});
