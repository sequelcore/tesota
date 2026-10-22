import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionFactory } from "../../../src/contract.ts";
import { createSession, openSession } from "../src/session.ts";
import { SessionLockedError } from "../src/session-lock.ts";
import type { EngineTool } from "../src/tool.ts";
import { codingTools } from "../src/tools/index.ts";
import { outputPrefix, platformShell } from "../src/tools/shell.ts";
import { accepts } from "./scripted.ts";

/**
 * A session in a process of its own, for the tests to kill hard or to race
 * for a session's lock (#437). It prints a line when it reaches the point
 * a test waits for, then waits there until it is killed. A new session
 * writes its file's path to `file.txt` in its folder.
 *
 * - `tool <cwd> <folder>`: a reply calls `wait`, which prints `waiting` and
 *   never ends, then `write`, which never starts.
 * - `read <cwd> <folder>`: the same call, declared read-only.
 * - `shell <cwd> <folder>`: the platform's shell prints a line, then waits for `release.txt`.
 * - `stream <cwd> <folder>`: a reply streams too slowly to finish first.
 * - `verify <cwd> <folder>`: the verifier prints `verifying` and never settles (#439).
 * - `receipt <cwd> <folder>`: the verifier records a receipt, and the
 *   process kills itself when the run's end is about to be written.
 * - `agent <cwd> <folder>`: the run starts a subagent in the background,
 *   which prints `child running` once its model is asked, and never ends (#525).
 * - `hold <file>`: opens the session and prints `opened`, or `locked` when
 *   another writer holds it.
 */
const [mode, first, second] = process.argv.slice(2);

const forever = (): Promise<never> => new Promise(() => { setInterval(() => undefined, 60_000); });

/** A tool that says it started, then runs until the process is killed. */
/** What verifies the run in each mode. */
const verifiers: Readonly<Record<string, ExtensionFactory>> = {
  verify: (pi) => { pi.on("agent_before_settle", () => { console.log("verifying"); return forever(); }); },
  receipt: (pi) => { pi.on("agent_before_settle", () => ({ entries: [{ type: "custom", customType: "receipt", data: { checked: true } }] })); },
};

const wait: EngineTool = {
  name: "wait", description: "Waits.", parameters: Type.Object({}),
  ...mode === "read" ? { access: "read" as const } : {},
  execute: async () => { console.log("waiting"); return forever(); },
};

if (mode === "hold") {
  try {
    const session = openSession(first ?? "", { models: createModels(), model: fauxProvider().getModel(), verifier: accepts });
    console.log("opened");
    void session;
    await forever();
  } catch (error) {
    console.log(error instanceof SessionLockedError ? "locked" : `failed: ${String(error)}`);
  }
} else {
  const cwd = first ?? "";
  const shell = platformShell();
  const command = shell.tool === "powershell" ? "Write-Output 'printed before interruption'; while (!(Test-Path 'release.txt')) { Start-Sleep -Milliseconds 20 }"
    : "echo 'printed before interruption'; while [ ! -f release.txt ]; do sleep 0.02; done";
  const faux = fauxProvider(mode === "stream" ? { tokensPerSecond: 5 } : {});
  // A subagent the run started, which says so once its model is asked and never answers (#525).
  const parentReplies = [fauxAssistantMessage([fauxToolCall("agent", { prompt: "work", description: "worker" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("waiting for the worker")];
  const routed = (context: { messages: readonly unknown[] }) => {
    const asked = context.messages.find((message) => (message as { role: string }).role === "user") as { content: unknown } | undefined;
    if (asked?.content !== "work") return parentReplies.shift() ?? fauxAssistantMessage("done");
    console.log("child running");
    return forever();
  };
  faux.setResponses(mode === "agent" ? [routed, routed, routed] : mode === "stream" ? [fauxAssistantMessage("a reply that streams slowly enough to be killed midway")]
    : mode !== undefined && mode in verifiers ? [fauxAssistantMessage("done")] : [fauxAssistantMessage([
      mode === "shell" ? fauxToolCall(shell.tool, { command }, { id: "shell|call:1" }) : fauxToolCall("wait", {}),
      fauxToolCall("write", { path: "never.txt", content: "x" })],
      { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd, folder: second ?? "", models, model: faux.getModel(),
    verifier: verifiers[mode ?? ""] ?? accepts, ...mode === "agent" ? {} : { tools: (spool: () => string) => [wait, ...codingTools(cwd, spool)] },
    writer: (writer) => ({ ...writer, append: (entry) => {
      if (mode === "receipt" && entry.type === "run_end") process.kill(process.pid, "SIGKILL");
      writer.append(entry);
    } }) });
  writeFileSync(join(second ?? "", "file.txt"), session.file);
  if (mode === "shell") {
    void (async () => {
      const folder = session.file.replace(/\.jsonl$/u, ".output");
      for (;;) {
        const name = existsSync(folder) ? readdirSync(folder).find((file) => file.startsWith(outputPrefix("shell|call:1"))) : undefined;
        if (name !== undefined && readFileSync(join(folder, name), "utf8").includes("printed before interruption")) break;
        await Bun.sleep(10);
      }
      console.log("printed");
    })();
  }
  await session.prompt("go");
}
