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
import { createProcessTesotaShell } from "../src/tesota-shell-command.js";

/**
 * A session in a repository works in the operator's files, and the operator
 * decides on its turns with /keep, /revert and /redo at any time, never at a
 * prompt that holds the session.
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

it("reverts a turn only after the operator says what to do with files its tools did not write, and redoes it", async () => {
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

  const record: ShellSessionRecord = { id: "session", title: "Session 1", engineId: "engine", workspace: null,
    entries: [], inspections: [], interrupted: false, blocked: false, retiredEngineIds: [], titleSource: "counter" };
  mocks.openStore.mockReturnValue({ list: () => [record], append: () => {}, block: () => {},
    setWorkspace: (_id: string, directory: string) => { record.workspace = directory; }, setTitle: () => false,
    setAgentModel: () => {}, allowedNetwork: () => [], markActive: () => {}, close: () => {} } as unknown as ShellSessionStore);
  // The real in-place session, kept in this test's folders rather than the operator's ~/.tesota.
  const create = SourceSession.create.bind(SourceSession);
  spies.push(vi.spyOn(SourceSession, "create").mockImplementation((directory, _root, options) =>
    create(directory, join(root, "source-sessions"), { ...options, sourcesRoot: join(root, "sources") })));
  // The agent writes price.ts with its write tool and a lock file by command, as `bun install` would.
  let onActivity: ((activity: AgentActivity) => void) | undefined;
  const run = vi.fn(async () => {
    onActivity?.({ type: "tool_started", call: "c1", tool: "write", subject: "price.ts" });
    await writeFile(join(source, "price.ts"), "export const price = 2;\n");
    onActivity?.({ type: "tool_finished", call: "c1", failed: false } as AgentActivity);
    await writeFile(join(source, "bun.lock"), "lock\n");
    return { status: "completed" as const, reply: "Raised the price." };
  });
  spies.push(vi.spyOn(ModelRuntime, "create").mockResolvedValue({ getModel: () => ({}) } as unknown as ModelRuntime),
    vi.spyOn(SessionManager, "findById").mockReturnValue(undefined),
    vi.spyOn(SessionManager, "create").mockReturnValue({} as SessionManager),
    vi.spyOn(CodingSession, "create").mockImplementation(async (options) => {
      onActivity = options.onActivity;
      return { run, dispose: vi.fn(), resumed: false } as unknown as CodingSession;
    }));
  const environment = { provider: "test", guarantees: hostProvider.guarantees, preparation: [],
    run: vi.fn(), dispose: vi.fn(async () => {}) } satisfies ExecutionEnvironment;
  const mode = { commands: "host", provider: { ...hostProvider, name: "test", prepare: async () => environment },
    missing: [] } satisfies SessionExecution;
  const shell = createProcessTesotaShell(source, "tesota-dark", async () => mode, "session");
  const notices: string[] = [];
  vi.spyOn(shell.surface, "writeTo").mockImplementation((_id, text) => { notices.push(text); });
  try {
    const session = shell.session("session");
    expect(await session.work("Raise the price")).toMatchObject({ status: "completed" });
    expect(session.place?.()).toBe("source");
    expect(notices.some((text) => text.includes("Changed outside the agent's file tools") && text.includes("bun.lock"))).toBe(true);
    const turns = shell.turnCommands;
    if (turns === undefined) throw new Error("No turn commands");

    await turns.revert("session", []);
    // Nothing is written until the operator says what to do with bun.lock.
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 2;\n");
    expect(notices.at(-1)).toContain("Use /revert all to revert them too, or /revert agent to leave them as they are.");

    await turns.revert("session", ["agent"]);
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 1;\n");
    expect(await readFile(join(source, "bun.lock"), "utf8")).toBe("lock\n");
    expect(notices.at(-1)).toContain("Left as the turn left them, as you chose:\n  bun.lock");

    await turns.redo("session");
    expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 2;\n");
    await turns.keep("session");
    expect(notices.at(-1)).toBe("Kept 1 turn. The changes are in your files.");
    await turns.revert("session", []);
    expect(notices.at(-1)).toBe("No turn is undecided.");
    expect(existsSync(join(source, ".git", "refs", "tesota"))).toBe(false);
  } finally {
    await shell.dispose?.();
  }
});
