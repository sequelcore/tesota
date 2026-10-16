import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createSession, openSession } from "../src/session.ts";
import { SessionLockedError } from "../src/session-lock.ts";
import type { EngineTool } from "../src/tool.ts";
import { codingTools } from "../src/tools/index.ts";
import { accepts } from "./scripted.ts";

/**
 * A session in a process of its own, for the tests to kill hard or to race
 * for a session's lock (#437). It prints a line when it reaches the point
 * a test waits for, then waits there until it is killed. A new session
 * writes its file's path to `file.txt` in its folder.
 *
 * - `tool <cwd> <folder>`: a reply calls `wait`, which prints `waiting` and
 *   never ends, then `write`, which never starts.
 * - `stream <cwd> <folder>`: a reply streams too slowly to finish first.
 * - `hold <file>`: opens the session and prints `opened`, or `locked` when
 *   another writer holds it.
 */
const [mode, first, second] = process.argv.slice(2);

const forever = (): Promise<never> => new Promise(() => { setInterval(() => undefined, 60_000); });

/** A tool that says it started, then runs until the process is killed. */
const wait: EngineTool = {
  name: "wait", description: "Waits.", parameters: Type.Object({}),
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
  const faux = fauxProvider(mode === "stream" ? { tokensPerSecond: 5 } : {});
  faux.setResponses(mode === "stream" ? [fauxAssistantMessage("a reply that streams slowly enough to be killed midway")]
    : [fauxAssistantMessage([fauxToolCall("wait", {}), fauxToolCall("write", { path: "never.txt", content: "x" })],
      { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd, folder: second ?? "", models, model: faux.getModel(), verifier: accepts,
    tools: (spool) => [wait, ...codingTools(cwd, spool)] });
  writeFileSync(join(second ?? "", "file.txt"), session.file);
  await session.prompt("go");
}
