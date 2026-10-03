import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CodingSession } from "../src/integrations/pi-coding-session.js";
import type { AgentActivity } from "../src/integrations/model-session-contract.js";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import type { SessionExecution } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";
import type { ShellSessionRecord, ShellSessionStore } from "../src/shell-session-store.js";
import { SourceSession } from "../src/source-session.js";
import { Workspace } from "../src/workspace.js";
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";

/**
 * A session in a repository works in the operator's files, and the operator
 * decides on its turns with /keep, /revert and /redo at any time, never at a
 * prompt that holds the session; one that chose /isolate before its first
 * request works in an isolated copy instead.
 */

const mocks = vi.hoisted(() => ({ openStore: vi.fn() }));
vi.mock("../src/shell-session-store.js", () => ({ openShellSessionStore: mocks.openStore }));
vi.mock("../src/model-roles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-roles.js")>();
  const { join: joinPath } = await import("node:path");
  const { tmpdir: temporary } = await import("node:os");
  return { ...actual, readModelChoices: () => actual.readModelChoices(joinPath(temporary(), "tesota-test-no-model-choices.json")) };
});

const roots: string[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A repository with one commit, whose shell's store holds `record` (or several, the shell resuming "session"), and whose agent runs `run`. */
async function openShell(record: ShellSessionRecord | readonly ShellSessionRecord[],
  run: () => Promise<{ status: "completed"; reply: string }>,
  activity: (listener: (activity: AgentActivity) => void) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "tesota-turns-"));
  roots.push(root);
  const source = join(root, "project");
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: source, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  spawnSync("git", ["init", "--quiet", source]);
  await writeFile(join(source, "price.ts"), "export const price = 1;\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "Fixture");

  const records = Array.isArray(record) ? record : [record];
  const find = (id: string): ShellSessionRecord => records.find((entry) => entry.id === id) ?? records[0];
  mocks.openStore.mockReturnValue({ list: () => records, append: () => {}, block: () => {},
    setWorkspace: (id: string, directory: string) => { find(id).workspace = directory; }, setTitle: () => false,
    setIsolated: (id: string) => { find(id).isolated = true; },
    setAgentModel: () => {}, allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore);
  // The real session and workspace, kept in this test's folders rather than the operator's ~/.tesota.
  const create = SourceSession.create.bind(SourceSession);
  spies.push(vi.spyOn(SourceSession, "create").mockImplementation((directory, _root, options) =>
    create(directory, join(root, "source-sessions"), { ...options, sourcesRoot: join(root, "sources") })));
  const createWorkspace = Workspace.create.bind(Workspace);
  spies.push(vi.spyOn(Workspace, "create").mockImplementation((directory, _root, options) =>
    createWorkspace(directory, join(root, "workspaces"), { ...options, sourcesRoot: join(root, "sources") })));
  spies.push(vi.spyOn(ModelRuntime, "create").mockResolvedValue({ getModel: () => ({}) } as unknown as ModelRuntime),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager),
    vi.spyOn(CodingSession, "create").mockImplementation(async (options) => {
      if (options.onActivity !== undefined) activity(options.onActivity);
      return { run, dispose: vi.fn(), resumed: false } as unknown as CodingSession;
    }));
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const shell = createProcessTesotaShell(source, "tesota-dark", async () => mode, "session");
  // Records and replies in the order the operator sees them; `replies` holds the ones not saved with the session.
  const notices: string[] = [];
  const replies: string[] = [];
  vi.spyOn(shell.surface, "writeTo").mockImplementation((_id, text) => { notices.push(text); });
  vi.spyOn(shell.surface, "replyTo").mockImplementation((_id, text) => { notices.push(text); replies.push(text); });
  const turns = shell.turnCommands;
  if (turns === undefined) throw new Error("No turn commands");
  return { source, shell, notices, replies, turns };
}

const newRecord = (id = "session", title = "Session 1"): ShellSessionRecord => ({ id, title, engineId: `engine-${id}`, workspace: null,
  entries: [], inspections: [], interrupted: false, blocked: false, retiredEngineIds: [], titleSource: "counter" });

it("reverts a turn only after the operator says what to do with files its tools did not write, and redoes it", async () => {
  // The agent writes price.ts with its write tool and a lock file by command, as `bun install` would.
  let onActivity: ((activity: AgentActivity) => void) | undefined;
  let source = "";
  const run = vi.fn(async () => {
    onActivity?.({ type: "tool_started", call: "c1", tool: "write", subject: "price.ts" });
    await writeFile(join(source, "price.ts"), "export const price = 2;\n");
    onActivity?.({ type: "tool_finished", call: "c1", failed: false } as AgentActivity);
    await writeFile(join(source, "bun.lock"), "lock\n");
    return { status: "completed" as const, reply: "Raised the price." };
  });
  const opened = await openShell(newRecord(), run, (listener) => { onActivity = listener; });
  source = opened.source;
  const { shell, notices, turns } = opened;
  // What the decision bar above the prompt is told after each step.
  const undecided = vi.spyOn(shell.surface, "setSessionUndecided");
  const latest = (): unknown => undecided.mock.calls.at(-1)?.[1];
  try {
    const session = shell.session("session");
    expect(await session.work("Raise the price")).toMatchObject({ status: "completed" });
    expect(session.place?.()).toBe("source");
    expect(latest()).toEqual({ turns: 1, files: 2, redoable: false });
    expect(notices.some((text) => text.includes("Changed outside the agent's file tools") && text.includes("bun.lock"))).toBe(true);

    await turns.revert("session", []);
    // Nothing is written until the operator says what to do with bun.lock.
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 2;\n");
    expect(notices.at(-1)).toContain("Use /revert all to revert them too, or /revert agent to leave them as they are.");

    await turns.revert("session", ["agent"]);
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 1;\n");
    expect(await readFile(join(source, "bun.lock"), "utf8")).toBe("lock\n");
    expect(notices.at(-1)).toContain("Left as the turn left them, as you chose:\n  bun.lock");
    expect(latest()).toEqual({ turns: 0, files: 0, redoable: true });

    await turns.redo("session");
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 2;\n");
    expect(latest()).toMatchObject({ turns: 1, redoable: false });
    await turns.keep("session");
    expect(notices.at(-1)).toBe("Kept 1 turn. The changes are in your files.");
    expect(latest()).toEqual({ turns: 0, files: 0, redoable: false });
    await turns.revert("session", []);
    expect(notices.at(-1)).toBe("No turn is undecided.");
    expect(existsSync(join(source, ".git", "refs", "tesota"))).toBe(false);
  } finally {
    await shell.dispose?.();
  }
});

it("works in an isolated copy when the session chose it before its first request, and keeps working where it started", async () => {
  const record = newRecord();
  let source = "";
  const run = vi.fn(async () => {
    await writeFile(join(source, "outside.txt"), "not the agent's\n");
    return { status: "completed" as const, reply: "Looked." };
  });
  const opened = await openShell(record, run);
  source = opened.source;
  const { shell, notices, replies, turns } = opened;
  try {
    await turns.isolate("session");
    expect(record.isolated).toBe(true);
    expect(notices.at(-1)).toContain("This session will work in an isolated copy, made with its first request");
    const session = shell.session("session");
    expect(await session.work("Look at the price")).toMatchObject({ status: "completed" });
    expect(session.place?.()).toBe("workspace");
    expect(notices).toContain("This session works in an isolated copy, as you chose: nothing in your files changes " +
      "until you apply its reviewed result.");
    await turns.isolate("session");
    expect(notices.at(-1)).toBe("This session already works in an isolated copy.");
    // The choice changed the session and is saved with it; being told it already holds is only an answer.
    expect(replies).toContain("This session already works in an isolated copy.");
    expect(replies.some((text) => text.startsWith("This session works in an isolated copy, as you chose"))).toBe(false);
    await turns.keep("session");
    expect(notices.at(-1)).toContain("This session works in a copy");
  } finally {
    await shell.dispose?.();
  }
});

it("keeps a session that already works in the operator's files there when it asks for isolation", async () => {
  const record = newRecord();
  const opened = await openShell(record, vi.fn(async () => ({ status: "completed" as const, reply: "Hello." })));
  const { shell, notices, turns } = opened;
  try {
    expect(await shell.session("session").work("Hello")).toMatchObject({ status: "completed" });
    await turns.isolate("session");
    expect(record.isolated).toBeUndefined();
    expect(notices.at(-1)).toBe("This session already works in your files, and keeps working there. " +
      "Isolation is chosen before a session's first request: start one with /new, then /isolate.");
  } finally {
    await shell.dispose?.();
  }
});

it("works in the operator's files once the session that worked there is idle with its turns decided, and names a session that holds them (#246)", async () => {
  let source = "";
  let edits = 0;
  // Every turn but the isolated session's writes the operator's files; that one's agent works in its copy.
  const writesSource = [true, false, true, true];
  const run = vi.fn(async () => {
    if (writesSource[run.mock.calls.length - 1] === true) {
      edits += 1;
      await writeFile(join(source, "price.ts"), `export const price = ${edits + 1};\n`);
    }
    return { status: "completed" as const, reply: "Changed the price." };
  });
  // Opened in this order, as the operator opens one session after another.
  const opened = await openShell([newRecord("first", "Session 1"), newRecord("session", "Session 2"),
    newRecord("third", "Session 3")], run);
  source = opened.source;
  const { shell, notices, turns } = opened;
  try {
    expect(await shell.session("first").work("Raise the price")).toMatchObject({ status: "completed" });
    expect(shell.session("first").place?.()).toBe("source");

    // Session 1's turn is undecided, so Session 2 works in a copy and is told which session holds the files and why.
    expect(await shell.session("session").work("Lower the price")).toMatchObject({ status: "completed" });
    expect(shell.session("session").place?.()).toBe("workspace");
    expect(notices).toContain("Session 1 has undecided turns in your files, so this session works in an isolated copy: " +
      "nothing in your files changes until you apply its reviewed result. A new session works in your files once you " +
      "keep or revert those turns in Session 1 (/keep or /revert).");

    // Kept, Session 1 is idle and holds nothing: the next new session works in the operator's files.
    await turns.keep("first");
    expect(await shell.session("third").work("Raise it again")).toMatchObject({ status: "completed" });
    expect(shell.session("third").place?.()).toBe("source");
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 3;\n");

    // Session 3's turn is undecided now, so Session 1 waits for it rather than mixing turns in the same files.
    expect(await shell.session("first").work("And again")).toEqual({ status: "failed", reason: "Session 3 has undecided " +
      "turns in your files, so this session can work there again once you keep or revert those turns in Session 3 " +
      "(/keep or /revert). Then send your request again." });
    expect(run).toHaveBeenCalledTimes(3);
    await turns.revert("third", ["all"]);
    expect(await shell.session("first").work("And again")).toMatchObject({ status: "completed" });
    expect(run).toHaveBeenCalledTimes(4);
  } finally {
    await shell.dispose?.();
  }
}, 30_000);
