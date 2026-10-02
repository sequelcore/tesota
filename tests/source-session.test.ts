import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendAssurance, correctionEntry, openAssurance, reviewEntry } from "../src/assurance-journal.js";
import { SourceSession } from "../src/source-session.js";

/**
 * Working in the source (docs/design/workspace.md): a turn is the pair of
 * trees before and after it in the source's shadow repository; the operator
 * keeps the changes already in their files, or reverts the latest turn,
 * which never replaces a file edited since.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-in-place-"));
  roots.push(root);
  const source = join(root, "project");
  await mkdir(join(source, "src"), { recursive: true });
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false", ...args], { cwd: source, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git("init", "--quiet");
  await writeFile(join(source, "src", "price.ts"), "export const price = 1;\n");
  await writeFile(join(source, "src", "old.ts"), "export const old = true;\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "Fixture");
  const options = { sourcesRoot: join(root, "sources"), kind: "repository" as const };
  const sessions = join(root, "sessions");
  const applications = join(root, "applications");
  return { root, source, git, sessions, applications,
    create: () => SourceSession.create(source, sessions, options) };
}

it("records a turn as the trees before and after it, without touching the operator's Git", async () => {
  const { source, git, create } = await fixture();
  const refs = git("for-each-ref");
  const session = await create();
  expect(session.checkout).toBe(session.source);
  const before = await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await writeFile(join(source, "src", "tax.ts"), "export const tax = 0.2;\n");
  await unlink(join(source, "src", "old.ts"));
  const turn = (await session.endTurn()).latest;
  expect(turn?.before).toBe(before);
  const snapshot = session.snapshot();
  expect(snapshot).toMatchObject({ base: before, tree: turn?.after });
  expect(snapshot.changes).toEqual([{ status: "deleted", path: "src/old.ts" }, { status: "modified", path: "src/price.ts" },
    { status: "added", path: "src/tax.ts" }]);
  expect(snapshot.diff).toContain("+export const tax = 0.2;");
  expect(session.contentAt(before, "src/old.ts")).toBe("export const old = true;\n");
  expect(git("for-each-ref")).toBe(refs);
});

it("leaves nothing to decide after a turn that changed nothing", async () => {
  const { create } = await fixture();
  const session = await create();
  await session.beginTurn();
  expect((await session.endTurn()).latest).toBeUndefined();
  expect(session.turns).toEqual([]);
  expect(session.snapshot().changes).toEqual([]);
});

it("reverts only the latest turn, restoring deleted and removing added files, and never a file edited since", async () => {
  const { source, create, applications } = await fixture();
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await session.endTurn();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 3;\n");
  await writeFile(join(source, "src", "tax.ts"), "export const tax = 0.2;\n");
  await unlink(join(source, "src", "old.ts"));
  await session.endTurn();
  // The operator edits a file the turn added, after the turn.
  await writeFile(join(source, "src", "tax.ts"), "export const tax = 0.25;\n");

  expect(await session.revert(applications)).toEqual({ restored: ["src/old.ts", "src/price.ts"], changedSince: ["src/tax.ts"], left: [] });
  expect(await readFile(join(source, "src", "price.ts"), "utf8")).toBe("export const price = 2;\n");
  expect(await readFile(join(source, "src", "old.ts"), "utf8")).toBe("export const old = true;\n");
  expect(await readFile(join(source, "src", "tax.ts"), "utf8")).toBe("export const tax = 0.25;\n");
  expect(session.turns).toHaveLength(1);

  expect(await session.revert(applications)).toEqual({ restored: ["src/price.ts"], changedSince: [], left: [] });
  expect(await readFile(join(source, "src", "price.ts"), "utf8")).toBe("export const price = 1;\n");
  expect(session.turns).toEqual([]);
  expect(await session.revert(applications)).toBeUndefined();
});

it("keeps the undecided turns by making the source's tree after them the base, and starts the requests over", async () => {
  const { source, create } = await fixture();
  const session = await create();
  await session.recordRequest("raise the price");
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  const turn = (await session.endTurn()).latest;
  await session.recordRequest("and add a test");
  expect(await session.requests()).toEqual(["raise the price", "and add a test"]);
  await session.keep();
  expect(session.base).toBe(turn?.after);
  expect(session.turns).toEqual([]);
  expect(await readFile(join(source, "src", "price.ts"), "utf8")).toBe("export const price = 2;\n");
  await session.recordRequest("something new");
  expect(await session.requests()).toEqual(["something new"]);
});

it("pins every tree it names in the shadow, and reopens with its undecided turns and a begun turn", async () => {
  const { source, create } = await fixture();
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  const turn = (await session.endTurn()).latest;
  const started = await session.beginTurn();
  const refs = spawnSync("git", ["-C", session.shadow, "for-each-ref", "--format=%(objectname)", "refs/tesota/sessions/"],
    { encoding: "utf8" }).stdout.trim().split("\n").sort();
  expect(refs).toEqual([session.base, turn?.before, turn?.after, started].sort());

  const reopened = await SourceSession.open(session.directory);
  expect(reopened.turns).toEqual([turn]);
  // A turn a crash interrupted keeps the tree from before it began.
  await writeFile(join(source, "src", "price.ts"), "export const price = 3;\n");
  expect(await reopened.beginTurn()).toBe(started);
  expect((await reopened.endTurn()).latest?.before).toBe(started);
  expect(existsSync(join(source, ".git", "refs", "tesota"))).toBe(false);
});

it("runs a failing check again on the tree before the turn, in a checkout of its own, never in the source", async () => {
  const { source, create } = await fixture();
  const { hostProvider } = await import("../src/host-environment.js");
  const { runChecks } = await import("../src/workspace-checks.js");
  const host = await hostProvider.prepare(source);
  const seen: string[] = [];
  // An environment that shows another folder at the source's path, as the WSL sandbox mounts one.
  const mounting = { ...host, runsInOtherFolders: true,
    run: (command: string, options: Parameters<typeof host.run>[1]) => {
      seen.push(options.root === undefined ? "source" : "base");
      const { root, ...rest } = options;
      return host.run(command, { ...rest, cwd: root ?? options.cwd });
    } };
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await session.endTurn();
  const check = { command: "node -e \"process.exit(require('fs').readFileSync('src/price.ts','utf8').includes('2') ? 1 : 0)\"",
    reports: [] };
  const [result] = await runChecks(mounting, session, session.snapshot(), [check], new AbortController().signal);
  expect(result).toMatchObject({ outcome: "failed", base: { outcome: "passed", origin: "introduced" } });
  expect(seen).toEqual(["source", "base"]);
  expect(await readFile(join(source, "src", "price.ts"), "utf8")).toBe("export const price = 2;\n");
  expect(existsSync(join(session.directory, "base"))).toBe(false);

  // An environment that cannot leaves whose failure it is unknown, never guessed.
  const [unknown] = await runChecks(host, session, session.snapshot(), [check], new AbortController().signal);
  expect(unknown?.base).toMatchObject({ outcome: "not_started", origin: "unknown" });
});

it("counts a correction as part of the turn it corrects, and names files the agent's own tools did not write", async () => {
  const { source, create, applications } = await fixture();
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await writeFile(join(source, "bun.lock"), "lock\n");
  const first = (await session.endTurn({ written: ["src/price.ts"] })).latest;
  expect(first?.outside).toEqual(["bun.lock"]);
  await session.beginTurn();
  await writeFile(join(source, "src", "tax.ts"), "export const tax = 0.2;\n");
  const corrected = (await session.endTurn({ written: ["src/tax.ts"], continues: true })).latest;
  expect(session.turns).toHaveLength(1);
  expect(corrected).toMatchObject({ before: first?.before, outside: ["bun.lock"] });
  // Reverting leaves what the operator chose to leave, exactly as the turn left it.
  expect(await session.revert(applications, ["bun.lock"])).toEqual({ restored: ["src/price.ts", "src/tax.ts"],
    changedSince: [], left: ["bun.lock"] });
  expect(await readFile(join(source, "bun.lock"), "utf8")).toBe("lock\n");
  expect(existsSync(join(source, "src", "tax.ts"))).toBe(false);
  session.discard();
  expect(spawnSync("git", ["-C", session.shadow, "for-each-ref", "refs/tesota/sessions/"], { encoding: "utf8" }).stdout).toBe("");
});

it("redoes the latest reverted turn, never replacing a file edited since, until new work starts", async () => {
  const { source, create, applications } = await fixture();
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await writeFile(join(source, "src", "tax.ts"), "export const tax = 0.2;\n");
  await session.endTurn({ written: ["src/price.ts", "src/tax.ts"] });
  await session.revert(applications);
  expect(session.redoable).toBeDefined();
  // The operator edits a file the reverted turn had changed; redo leaves it.
  await writeFile(join(source, "src", "price.ts"), "export const price = 5;\n");
  expect(await session.redo(applications)).toEqual({ restored: ["src/tax.ts"], changedSince: ["src/price.ts"] });
  expect(await readFile(join(source, "src", "tax.ts"), "utf8")).toBe("export const tax = 0.2;\n");
  expect(await readFile(join(source, "src", "price.ts"), "utf8")).toBe("export const price = 5;\n");
  expect(session.turns).toHaveLength(1);
  expect(session.redoable).toBeUndefined();

  await session.revert(applications);
  await session.beginTurn();
  await writeFile(join(source, "src", "old.ts"), "export const old = false;\n");
  await session.endTurn();
  expect(session.redoable).toBeUndefined();
  expect(await session.redo(applications)).toBeUndefined();
});

it("reviews the fix made before a stopped correction round, with the turn that resumed it (#249)", async () => {
  const { source, create } = await fixture();
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await session.endTurn();
  const reviewed = session.candidate((await openAssurance(session.directory)).reviewed);
  await appendAssurance(session.directory, reviewEntry("changes", reviewed, ["Read the setting"], [], [], []));
  // The correction is journaled as it is sent, then the agent edits a file and the operator stops the round.
  await appendAssurance(session.directory, correctionEntry({ previousTree: reviewed.tree, sentBack: [] }));
  await session.beginTurn();
  await writeFile(join(source, "src", "registry.ts"), "export const key = \"HKCU\";\n");
  await session.endTurn({ continues: true });
  // "continue i stopped by accident" is the operator's own turn.
  await session.beginTurn();
  await writeFile(join(source, "src", "registry.test.ts"), "test(\"key\");\n");
  await session.endTurn();
  expect(session.turns).toHaveLength(2);
  expect(session.snapshot().diff).not.toContain("HKCU");
  const open = await openAssurance(session.directory);
  const candidate = session.candidate(open.reviewed);
  expect(candidate.base).toBe(reviewed.base);
  expect(candidate.changes.map((change) => change.path)).toEqual(["src/price.ts", "src/registry.test.ts", "src/registry.ts"]);
  // The review judges the correction from the result it was sent from: the edit before the stop and the turn after it.
  expect(open.correction?.previousTree).toBe(reviewed.tree);
  const correction = session.compare(reviewed.tree, candidate.tree);
  expect(correction.changes.map((change) => change.path)).toEqual(["src/registry.test.ts", "src/registry.ts"]);
  expect(correction.diff).toContain("+export const key = \"HKCU\";");
  // The whole commands that follow the review check the candidate it judged.
  await appendAssurance(session.directory, reviewEntry("changes", candidate, [], [], [], []));
  expect(session.candidate((await openAssurance(session.directory)).reviewed)).toEqual(candidate);
});

it("reviews a turn after the last reviewed one alone, and a stopped turn no review saw with the turn after it", async () => {
  const { source, create } = await fixture();
  const session = await create();
  await session.beginTurn();
  await writeFile(join(source, "src", "price.ts"), "export const price = 2;\n");
  await session.endTurn();
  const first = session.candidate(undefined);
  await appendAssurance(session.directory, reviewEntry("changes", first, [], [], [], []));
  // The operator stops the next turn before its review; the one after it continues the work.
  await session.beginTurn();
  await writeFile(join(source, "src", "tax.ts"), "export const tax = 0.2;\n");
  await session.endTurn();
  const stopped = session.turns.at(-1);
  await session.beginTurn();
  await writeFile(join(source, "src", "tax.test.ts"), "test(\"tax\");\n");
  await session.endTurn();
  const candidate = session.candidate((await openAssurance(session.directory)).reviewed);
  expect(candidate.base).toBe(stopped?.before);
  expect(candidate.changes.map((change) => change.path)).toEqual(["src/tax.test.ts", "src/tax.ts"]);
  // Once reviewed, the next turn is reviewed alone.
  await appendAssurance(session.directory, reviewEntry("changes", candidate, [], [], [], []));
  await session.beginTurn();
  await writeFile(join(source, "src", "old.ts"), "export const old = false;\n");
  await session.endTurn();
  expect(session.candidate((await openAssurance(session.directory)).reviewed)).toEqual(session.snapshot());
});
