import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage, Session } from "../../../src/contract.ts";
import { tesotaEngine } from "./adapters/tesota.ts";
import type { ScriptStep, TestEngine } from "./engine.ts";

/**
 * The agent loop and its tools (#435), the same on every engine: each test
 * checks what the tools did to the files, which calls failed and in what
 * order, never how an engine words its output.
 */
const engines: readonly TestEngine[] = [tesotaEngine];

const open: Session[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const results = (session: Session): ConversationMessage[] => session.messages().filter((message) => message.role === "toolResult");

for (const engine of engines) {
  /** A session in a fresh folder, and that folder. */
  const start = async (script: readonly ScriptStep[], slow = false) => {
    const cwd = mkdtempSync(join(tmpdir(), "tesota-core-loop-"));
    const session = await engine.createSession({ cwd, script, extensions: [], slow });
    open.push(session);
    return { session, cwd };
  };

  /** A command in the platform's shell; PowerShell and bash spell some of them differently. */
  const command = (powershell: string, bash: string): ScriptStep =>
    ({ tool: engine.shell, args: { command: engine.shell === "powershell" ? powershell : bash } });

  describe(engine.name, () => {
    test("a reply without tool calls ends the loop", async () => {
      const { session } = await start(["hello"]);
      await session.prompt("hi");
      expect(session.messages().map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(session.lastAssistantText()).toBe("hello");
      expect(session.outcome()).toBe("completed");
    });

    test("the agent writes a file, reads it back and answers after the tool rounds", async () => {
      const { session, cwd } = await start([
        { tool: "write", args: { path: "notes.txt", content: "alpha\nbeta\n" } },
        { tool: "read", args: { path: "notes.txt" } },
        "done",
      ]);
      await session.prompt("go");
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");
      expect(results(session).map((result) => [result.toolName, result.isError])).toEqual([["write", false], ["read", false]]);
      expect(results(session)[1]?.text).toContain("alpha\nbeta");
      expect(session.lastAssistantText()).toBe("done");
    });

    test("several calls in one reply run in order, each with its own result", async () => {
      const { session, cwd } = await start([
        { calls: [{ tool: "write", args: { path: "a.txt", content: "a" } }, { tool: "write", args: { path: "b.txt", content: "b" } }] },
        "done",
      ]);
      await session.prompt("go");
      expect(session.messages().map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
      expect(readFileSync(join(cwd, "a.txt"), "utf8") + readFileSync(join(cwd, "b.txt"), "utf8")).toBe("ab");
    });

    test("an unknown tool and invalid arguments fail the call, and the loop goes on", async () => {
      const { session } = await start([{ tool: "no_such_tool", args: {} }, { tool: "read", args: {} }, "done"]);
      await session.prompt("go");
      expect(results(session).map((result) => result.isError)).toEqual([true, true]);
      expect(session.lastAssistantText()).toBe("done");
    });

    test("arguments that aren't an object fail the call with a reason the model can read, and the loop goes on (#664)", async () => {
      const odd = [null, "path", 3, ["path"]] as unknown as JsonObject[];
      const { session } = await start([{ calls: ["write", engine.shell].flatMap((tool) => odd.map((args) => ({ tool, args }))) }, "done"]);
      await session.prompt("go");
      expect(results(session).map((result) => result.isError)).toEqual(Array(8).fill(true));
      expect(results(session).every((result) => (result.text ?? "") !== "")).toBe(true);
      expect(session.lastAssistantText()).toBe("done");
    });

    test("a reply cut off by the output limit runs none of its calls", async () => {
      const { session, cwd } = await start([{ calls: [{ tool: "write", args: { path: "cut.txt", content: "x" } }], cutOff: true }, "done"]);
      await session.prompt("go");
      expect(existsSync(join(cwd, "cut.txt"))).toBe(false);
      expect(results(session).map((result) => result.isError)).toEqual([true]);
    });

    test("a provider failure ends the run as an error", async () => {
      const { session } = await start([{ error: "the provider is down" }]);
      await session.prompt("go");
      expect(session.outcome()).toBe("error");
    });

    test("edits apply when each text occurs exactly once, keeping the file's line endings", async () => {
      const { session, cwd } = await start([
        { tool: "edit", args: { path: "code.ts", edits: [{ oldText: "one", newText: "uno" }, { oldText: "three", newText: "tres" }] } },
        "done",
      ]);
      writeFileSync(join(cwd, "code.ts"), "one\r\ntwo\r\nthree\r\n");
      await session.prompt("go");
      expect(results(session)[0]?.isError).toBe(false);
      expect(readFileSync(join(cwd, "code.ts"), "utf8")).toBe("uno\r\ntwo\r\ntres\r\n");
    });

    test("an edit that is missing or ambiguous fails, and none of the edits is written", async () => {
      const { session, cwd } = await start([
        { tool: "edit", args: { path: "code.ts", edits: [{ oldText: "first", newText: "1st" }, { oldText: "same", newText: "x" }] } },
        { tool: "edit", args: { path: "code.ts", edits: [{ oldText: "first", newText: "1st" }, { oldText: "absent", newText: "x" }] } },
        "done",
      ]);
      writeFileSync(join(cwd, "code.ts"), "first\nsame\nsame\n");
      await session.prompt("go");
      expect(results(session).map((result) => result.isError)).toEqual([true, true]);
      expect(readFileSync(join(cwd, "code.ts"), "utf8")).toBe("first\nsame\nsame\n");
    });

    test("an edit whose text matches only with a different quote character fails", async () => {
      const { session, cwd } = await start([{ tool: "edit", args: { path: "doc.md", edits: [{ oldText: "it's", newText: "it is" }] } }, "done"]);
      writeFileSync(join(cwd, "doc.md"), "it’s here\n");
      await session.prompt("go");
      expect(results(session)[0]?.isError).toBe(true);
      expect(readFileSync(join(cwd, "doc.md"), "utf8")).toBe("it’s here\n");
    });

    test("read gives a page of the file from offset, limit lines long", async () => {
      const { session, cwd } = await start([{ tool: "read", args: { path: "lines.txt", offset: 2, limit: 1 } }, "done"]);
      writeFileSync(join(cwd, "lines.txt"), "line-a\nline-b\nline-c\n");
      await session.prompt("go");
      const text = results(session)[0]?.text ?? "";
      expect(text).toContain("line-b");
      expect(text).not.toContain("line-a");
      expect(text).not.toContain("line-c");
    });

    test("paths resolve natively: nested relative paths, the platform's separator and absolute paths", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-paths-"));
      mkdirSync(join(cwd, "src"));
      const nested = process.platform === "win32" ? "out\\deep\\file.txt" : "out/deep/file.txt";
      const session = await engine.createSession({ cwd, extensions: [], script: [
        { tool: "write", args: { path: nested, content: "nested" } },
        { tool: "write", args: { path: join(cwd, "src", "absolute.txt"), content: "absolute" } },
        "done",
      ] });
      open.push(session);
      await session.prompt("go");
      expect(readFileSync(join(cwd, "out", "deep", "file.txt"), "utf8")).toBe("nested");
      expect(readFileSync(join(cwd, "src", "absolute.txt"), "utf8")).toBe("absolute");
    });

    test("a shell command's output comes back, and a non-zero exit fails the call", async () => {
      const { session } = await start([
        command("Write-Output 'shell-ok'", "echo shell-ok"),
        command("Write-Output 'before-exit'; exit 3", "echo before-exit; exit 3"),
        "done",
      ]);
      await session.prompt("go");
      const [ok, failed] = results(session);
      expect([ok?.isError, failed?.isError]).toEqual([false, true]);
      expect(ok?.text).toContain("shell-ok");
      expect(failed?.text).toContain("before-exit");
    });

    test("long shell output keeps its end", async () => {
      const { session } = await start([
        command("1..3000 | ForEach-Object { 'L{0:D4}' -f $_ }", "for i in $(seq 1 3000); do printf 'L%04d\\n' $i; done"),
        "done",
      ]);
      await session.prompt("go");
      const text = results(session)[0]?.text ?? "";
      expect(text).toContain("L3000");
      expect(text).not.toContain("L0001");
    });

    test("a command past its timeout is stopped and fails the call", async () => {
      const { session } = await start([{ tool: engine.shell, args: { command: engine.shell === "powershell" ? "Start-Sleep 30" : "sleep 30", timeout: 1 } }, "done"]);
      const started = Date.now();
      await session.prompt("go");
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(results(session)[0]?.isError).toBe(true);
    });

    test("aborting during a command stops it and ends the run as aborted", async () => {
      const { session } = await start([command("Start-Sleep 30", "sleep 30"), "never reached"]);
      const run = session.prompt("go");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const stopping = Date.now();
      await session.abort();
      await run;
      expect(Date.now() - stopping).toBeLessThan(10_000);
      expect(session.outcome()).toBe("aborted");
    });

    test("two sessions run at the same time, each with its own conversation and usage", async () => {
      const [a, b] = await Promise.all([start(["from a"]), start(["from b"])]);
      await Promise.all([a.session.prompt("first"), b.session.prompt("second")]);
      expect(a.session.lastAssistantText()).toBe("from a");
      expect(b.session.lastAssistantText()).toBe("from b");
      expect(a.session.stats().tokens.total).toBeGreaterThan(0);
      expect(b.session.stats().tokens.total).toBeGreaterThan(0);
    });
  });
}
