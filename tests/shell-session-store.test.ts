import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openShellSessionStore } from "../src/shell-session-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tesota-shell-store-"));
  roots.push(root);
  return { root, source: join(root, "repository") };
}

it("restores recorded conversation without treating it as task authority", () => {
  const { root, source } = fixture();
  const first = openShellSessionStore(source, root);
  const session = first.create();
  first.append(session.id, "user", "Inspect the repo");
  first.append(session.id, "tesota", "One answer with limits");
  first.markActive(session.id, true);
  expect(() => openShellSessionStore(source, root)).toThrow(/already has an open/);
  first.close();

  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()).toEqual([{ ...session, entries: [
    { role: "user", text: "Inspect the repo" }, { role: "tesota", text: "One answer with limits" },
  ], interrupted: true }]);
  reopened.close();
});

it("rejects a corrupt session snapshot instead of showing a clean history", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  store.create();
  store.close();
  const file = readdirSync(root).find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("Missing snapshot");
  expect(readFileSync(join(root, file), "utf8")).toContain("tesota-shell-sessions");
  writeFileSync(join(root, file), "{broken");
  expect(() => openShellSessionStore(source, root)).toThrow();
});

it("persists session workspaces, the repository's approved checks and engine identity", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  const session = store.create();
  store.setWorkspace(session.id, join(root, "workspace"));
  expect(store.checks()).toBeNull();
  store.setChecks(["bun run check"]);
  const previousEngine = session.engineId;
  const nextEngine = store.rotateEngine(session.id);
  expect(nextEngine).not.toBe(previousEngine);
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]).toMatchObject({ workspace: join(root, "workspace"), engineId: nextEngine });
  expect(reopened.checks()).toEqual(["bun run check"]);
  reopened.close();
});

it("discards an older snapshot version and starts with no sessions", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  store.create();
  store.close();
  const file = readdirSync(root).find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("Missing snapshot");
  writeFileSync(join(root, file), JSON.stringify({ format: "tesota-shell-sessions", version: 1, source, sessions: [] }));
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()).toEqual([]);
  expect(readdirSync(root).filter((name) => name.includes(".bak"))).toEqual([]);
  reopened.close();
});

it("removes a session and never reuses a title number while others remain", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  const first = store.create();
  const second = store.create();
  store.remove(first.id);
  expect(store.create().title).toBe("Session 3");
  expect(store.list().map((session) => session.id)).not.toContain(first.id);
  expect(() => { store.remove(first.id); }).toThrow("unavailable");
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list().map((session) => session.title)).toEqual([second.title, "Session 3"]);
  reopened.close();
});
