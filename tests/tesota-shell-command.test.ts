import { expect, it, vi } from "vitest";
import { runTesotaShellCommand, type SessionWork, type WorkspaceCallbacks } from "../src/tesota-shell-command.js";
import type { WorkResult } from "../src/tesota-shell.js";
import type { TesotaShellTerminal } from "../src/tesota-shell-terminal.js";

type Controls = WorkspaceCallbacks;

function surface(overrides: Partial<TesotaShellTerminal> = {}): { surface: TesotaShellTerminal; events: string[] } {
  const events: string[] = [];
  return { events, surface: {
    start: () => { events.push("start"); }, stop: () => { events.push("stop"); },
    write: (text) => { events.push(text); }, ask: async () => "",
    report: () => {}, refreshElapsed: () => {}, inspect: () => {}, addSession: () => {}, selectSession: () => {},
    writeTo: (_id, text) => { events.push(text); }, askIn: async () => "",
    reportFor: () => {}, clearProgressFor: () => {}, inspectFor: () => {}, showActivity: () => {}, setSessionExecution: () => {}, setSessionPlan: () => {},
    setBranch: () => {}, setSessionModel: () => {}, blockSession: () => {}, endSession: () => {}, removeSession: () => {},
    ...overrides,
  } };
}

function work(result: (request: string) => Promise<WorkResult>): SessionWork {
  return { work: result, checks: () => [], suggestChecks: () => [], setChecks: () => {},
    review: vi.fn(), apply: vi.fn(), reject: vi.fn() };
}

it("owns the persistent surface for the whole shell session", async () => {
  const fixture = surface();
  let controls: Controls | undefined;
  const running = runTesotaShellCommand({ surface: fixture.surface, initialSessionId: "default",
    session: () => work(vi.fn()), configureWorkspace: (callbacks) => { controls = callbacks; } });
  await vi.waitFor(() => { expect(fixture.events).toContain("Session ended.\n"); });
  controls?.quit();
  await expect(running).resolves.toBe(0);
  expect(fixture.events.at(0)).toBe("start");
  expect(fixture.events.at(-1)).toBe("stop");
});

it("returns only after the sessions' environments are released, since the process exits on return", async () => {
  const fixture = surface();
  let controls: Controls | undefined;
  let finishRelease: (() => void) | undefined;
  let returned = false;
  const running = runTesotaShellCommand({ surface: fixture.surface, initialSessionId: "default",
    session: () => work(vi.fn()), configureWorkspace: (callbacks) => { controls = callbacks; },
    dispose: () => new Promise<void>((settle) => { finishRelease = settle; }) }).then((code) => { returned = true; return code; });
  await vi.waitFor(() => { expect(fixture.events).toContain("Session ended.\n"); });
  controls?.quit();
  await vi.waitFor(() => { expect(finishRelease).toBeDefined(); });
  await new Promise((settle) => { setTimeout(settle, 20); });
  expect(returned).toBe(false);
  finishRelease?.();
  await expect(running).resolves.toBe(0);
});

it("routes simultaneous session turns to their own conversation", async () => {
  const pending = new Map<string, (answer: string) => void>();
  const output: { id: string; text: string }[] = [];
  let controls: Controls | undefined;
  const release = new Map<string, (result: WorkResult) => void>();
  const sessions = new Map<string, SessionWork>();
  const fixture = surface({
    writeTo: (id, text) => { output.push({ id, text }); },
    askIn: (id) => new Promise<string>((resolve) => { pending.set(id, resolve); }),
  });
  const running = runTesotaShellCommand({ surface: fixture.surface, initialSessionId: "default",
    session: (id) => {
      const created = work(vi.fn(() => new Promise<WorkResult>((resolve) => { release.set(id, resolve); })));
      sessions.set(id, created);
      return created;
    },
    configureWorkspace: (callbacks) => { controls = callbacks; } });
  await vi.waitFor(() => { expect(controls).toBeDefined(); });
  controls?.newSession("other");
  pending.get("default")?.("Question A");
  pending.get("other")?.("Question B");
  await vi.waitFor(() => { expect(release.size).toBe(2); });
  expect(sessions.get("default")?.work).toHaveBeenCalledWith("Question A");
  expect(sessions.get("other")?.work).toHaveBeenCalledWith("Question B");
  release.get("other")?.({ status: "failed", reason: "B stopped" });
  await vi.waitFor(() => { expect(output).toContainEqual({ id: "other", text: "The request failed: B stopped\n" }); });
  expect(output.some((event) => event.id === "default" && event.text.includes("stopped"))).toBe(false);
  release.get("default")?.({ status: "failed", reason: "A stopped" });
  await vi.waitFor(() => { expect(output).toContainEqual({ id: "default", text: "The request failed: A stopped\n" }); });
  pending.get("other")?.("");
  pending.get("default")?.("");
  controls?.quit();
  await expect(running).resolves.toBe(0);
});

it("does not restart an ended session on selection", async () => {
  const ended: string[] = [];
  const askIn = vi.fn(async () => "");
  let controls: Controls | undefined;
  const fixture = surface({ askIn, endSession: (id) => { ended.push(id); } });
  const running = runTesotaShellCommand({ surface: fixture.surface, initialSessionId: "default",
    session: () => work(vi.fn()), configureWorkspace: (callbacks) => { controls = callbacks; } });
  await vi.waitFor(() => { expect(ended).toEqual(["default"]); });
  controls?.selectSession("default");
  expect(askIn).toHaveBeenCalledTimes(1);
  controls?.quit();
  await expect(running).resolves.toBe(0);
});

it("reports a failed session and keeps the shell open", async () => {
  const fixture = surface({ askIn: async () => "Fix it" });
  let controls: Controls | undefined;
  const ended: string[] = [];
  const running = runTesotaShellCommand({ surface: { ...fixture.surface, endSession: (id) => { ended.push(id); } },
    initialSessionId: "default", session: () => work(async () => { throw new Error("broken"); }),
    configureWorkspace: (callbacks) => { controls = callbacks; } });
  await vi.waitFor(() => { expect(ended).toEqual(["default"]); });
  expect(fixture.events).toContain("Session failed. Pending changes stay in the workspace.\n");
  controls?.quit();
  await expect(running).resolves.toBe(0);
});

it("stops a closed session's runner without writing to it", async () => {
  const pending = new Map<string, (error: Error) => void>();
  const ended: string[] = [];
  const written: string[] = [];
  let controls: Controls | undefined;
  const fixture = surface({
    askIn: (id) => new Promise<string>((_resolve, reject) => { pending.set(id, reject); }),
    writeTo: (id, text) => { written.push(`${id}:${text}`); },
    endSession: (id) => { ended.push(id); },
  });
  const running = runTesotaShellCommand({ surface: fixture.surface, initialSessionId: "default",
    session: () => work(vi.fn()), configureWorkspace: (callbacks) => { controls = callbacks; } });
  await vi.waitFor(() => { expect(pending.has("default")).toBe(true); });
  controls?.closed("default");
  pending.get("default")?.(new DOMException("closed", "AbortError"));
  controls?.selectSession("default");
  controls?.quit();
  await expect(running).resolves.toBe(0);
  expect(ended).toEqual([]);
  expect(written.filter((entry) => entry.startsWith("default:"))).toEqual([]);
});
