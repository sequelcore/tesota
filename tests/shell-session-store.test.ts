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
  first.append(session.id, { kind: "user", text: "Inspect the repo" });
  first.append(session.id, { kind: "agent", text: "One answer with limits" });
  first.append(session.id, { kind: "tool", tool: "bash", subject: "bun test", failed: false });
  const change = { added: 1, removed: 1, lines: ["@@ -1 +1 @@", "-old", "+new"] };
  first.append(session.id, { kind: "tool", tool: "edit", subject: "src/a.ts", failed: false, change });
  first.markActive(session.id, true);
  expect(() => openShellSessionStore(source, root)).toThrow(/already has an open/);
  first.close();

  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()).toEqual([{ ...session, entries: [
    { kind: "user", text: "Inspect the repo" }, { kind: "agent", text: "One answer with limits" },
    { kind: "tool", tool: "bash", subject: "bun test", failed: false },
    { kind: "tool", tool: "edit", subject: "src/a.ts", failed: false, change },
  ], interrupted: true }]);
  reopened.close();
});

it("keeps a result's diff, and reopens a result recorded before results had one", () => {
  const { root, source } = fixture();
  const first = openShellSessionStore(source, root);
  const session = first.create();
  first.inspect(session.id, { title: "Review · 1 file", summary: "s", detail: "d", diff: "diff --git a/a b/a" });
  first.inspect(session.id, { title: "Review · 1 file", summary: "s", detail: "d\n\nDiff\ndiff --git a/a b/a" });
  first.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]?.inspections).toEqual([
    { title: "Review · 1 file", summary: "s", detail: "d", diff: "diff --git a/a b/a" },
    { title: "Review · 1 file", summary: "s", detail: "d\n\nDiff\ndiff --git a/a b/a" }]);
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
  expect(() => store.setChecks([{ command: "bun run test", reports: ["../outside.xml"] }])).toThrow();
  store.setChecks([{ command: "bun run check", reports: ["test-reports/unit.xml", "test-reports/workspace.xml"] },
    { command: "bun run lint", reports: [] }]);
  const previousEngine = session.engineId;
  const nextEngine = store.rotateEngine(session.id);
  expect(nextEngine).not.toBe(previousEngine);
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]).toMatchObject({ workspace: join(root, "workspace"), engineId: nextEngine });
  expect(reopened.checks()).toEqual([{ command: "bun run check", reports: ["test-reports/unit.xml", "test-reports/workspace.xml"] },
    { command: "bun run lint", reports: [] }]);
  reopened.close();
});

it("keeps a session's agent model and the conversations it left, and reads a session saved before either", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  const session = store.create();
  expect(session.agent).toBeUndefined();
  store.setAgentModel(session.id, "claude-code:opus");
  expect(session.sandbox).toBeUndefined();
  store.setSandbox(session.id, "docker");
  const first = session.engineId;
  const second = store.rotateEngine(session.id);
  store.rotateEngine(session.id);
  expect(() => { store.setAgentModel(session.id, "not a model"); }).toThrow();
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]).toMatchObject({ agent: "claude-code:opus", sandbox: "docker", retiredEngineIds: [first, second] });
  // Without a choice of its own, a session follows the operator's choice for new sessions.
  reopened.setSandbox(session.id, undefined);
  expect(reopened.list()[0]?.sandbox).toBeUndefined();
  reopened.close();
});

it("persists network destinations allowed for the repository and refuses anything else", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  expect(store.allowedNetwork()).toEqual([]);
  store.allowNetwork(["api.github.com:443"]);
  store.allowNetwork(["api.github.com:443", "example.org:80"]);
  expect(() => { store.allowNetwork(["**"]); }).toThrow();
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.allowedNetwork()).toEqual(["api.github.com:443", "example.org:80"]);
  reopened.close();
});

it("persists rules for commands on this computer, once each, refusing any rule that may not be saved (decision 049)", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  const session = store.create();
  expect(store.commandRules()).toEqual([]);
  store.saveCommandRule(["gh", "pr"]);
  store.saveCommandRule(["gh", "pr"]);
  expect(() => { store.saveCommandRule(["bash", "-c"]); }).toThrow();
  expect(() => { store.saveCommandRule(["gh"]); }).toThrow();
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.commandRules()).toEqual([["gh", "pr"]]);
  reopened.close();
  // A file written before rules existed still opens, with its sessions and no rules.
  const [file] = readdirSync(root).filter((name) => name.endsWith(".json"));
  const path = join(root, file ?? "");
  const saved: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
  delete saved["commandRules"];
  writeFileSync(path, JSON.stringify(saved));
  const earlier = openShellSessionStore(source, root);
  expect(earlier.commandRules()).toEqual([]);
  expect(earlier.list().map((entry) => entry.id)).toEqual([session.id]);
  earlier.close();
});

it("keeps the newest measured reviews", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  for (let index = 0; index < 22; index += 1) {
    store.recordReviewMeasurement({ at: "2026-09-25T00:00:00.000Z", depth: "deep", correction: false, durationMs: index, tokens: index });
  }
  expect(() => { store.recordReviewMeasurement({ at: "now", depth: "deep", correction: false, durationMs: 1, tokens: 1 }); }).toThrow();
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.reviewMeasurements().map((entry) => entry.tokens)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
  reopened.close();
});

it("discards an older snapshot version and starts with no sessions", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  store.create();
  store.close();
  const file = readdirSync(root).find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("Missing snapshot");
  // Version 6 kept checks as bare commands, without their reports.
  writeFileSync(join(root, file), JSON.stringify({ format: "tesota-shell-sessions", version: 6, source,
    checks: ["bun run check"], network: [], reviews: [], sessions: [] }));
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()).toEqual([]);
  expect(reopened.checks()).toBeNull();
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

it("keeps a session's plan across restarts, clears it, and refuses one that is not a plan", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  const session = store.create();
  expect(session.plan).toBeUndefined();
  store.setPlan(session.id, [{ step: "Update the totals", status: "in_progress", check: "recalculates with zero errors" }]);
  expect(() => { store.setPlan(session.id, [{ step: "x", status: "finished" } as never]); }).toThrow();
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]?.plan).toEqual([{ step: "Update the totals", status: "in_progress", check: "recalculates with zero errors" }]);
  reopened.setPlan(session.id, undefined);
  expect(reopened.list()[0]?.plan).toBeUndefined();
  reopened.close();
});

it("opens the same saved sessions whatever the case of the path, as the path finds them", () => {
  const { root, source } = fixture();
  const first = openShellSessionStore(source, root);
  const session = first.create();
  first.close();
  // Windows paths ignore case: a shell opened from C:\proyectos is the one saved from C:\Proyectos.
  const other = source.replace(/repository$/u, "REPOSITORY");
  const reopened = openShellSessionStore(other, root);
  expect(reopened.list().map((entry) => entry.id)).toContain(session.id);
  reopened.close();
});
