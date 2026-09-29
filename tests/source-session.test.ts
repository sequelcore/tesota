import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
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
  const turn = await session.endTurn();
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
  expect(await session.endTurn()).toBeUndefined();
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

  expect(await session.revert(applications)).toEqual({ restored: ["src/old.ts", "src/price.ts"], changedSince: ["src/tax.ts"] });
  expect(await readFile(join(source, "src", "price.ts"), "utf8")).toBe("export const price = 2;\n");
  expect(await readFile(join(source, "src", "old.ts"), "utf8")).toBe("export const old = true;\n");
  expect(await readFile(join(source, "src", "tax.ts"), "utf8")).toBe("export const tax = 0.25;\n");
  expect(session.turns).toHaveLength(1);

  expect(await session.revert(applications)).toEqual({ restored: ["src/price.ts"], changedSince: [] });
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
  const turn = await session.endTurn();
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
  const turn = await session.endTurn();
  const started = await session.beginTurn();
  const refs = spawnSync("git", ["-C", session.shadow, "for-each-ref", "--format=%(objectname)", "refs/tesota/sessions/"],
    { encoding: "utf8" }).stdout.trim().split("\n").sort();
  expect(refs).toEqual([session.base, turn?.before, turn?.after, started].sort());

  const reopened = await SourceSession.open(session.directory);
  expect(reopened.turns).toEqual([turn]);
  // A turn a crash interrupted keeps the tree from before it began.
  await writeFile(join(source, "src", "price.ts"), "export const price = 3;\n");
  expect(await reopened.beginTurn()).toBe(started);
  expect((await reopened.endTurn())?.before).toBe(started);
  expect(existsSync(join(source, ".git", "refs", "tesota"))).toBe(false);
});
