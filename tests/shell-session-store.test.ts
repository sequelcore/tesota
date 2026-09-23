import { randomUUID } from "node:crypto";
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

it("carries cumulative limits across a fresh Pi engine identity", () => {
  const { root, source } = fixture();
  const store = openShellSessionStore(source, root);
  const session = store.create();
  store.recordBudget(session.id, { turns: 3, modelInvocations: 8, toolCalls: 12 });
  const proposalId = randomUUID();
  store.linkProposal(session.id, proposalId);
  const oldEngine = session.engineId;
  const nextEngine = store.rotateEngine(session.id);
  expect(nextEngine).not.toBe(oldEngine);
  expect(() => store.recordBudget(session.id, { turns: 2, modelInvocations: 8, toolCalls: 12 }))
    .toThrow(/cannot move backwards/);
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]?.budget).toEqual({ turns: 3, modelInvocations: 8, toolCalls: 12 });
  expect(reopened.list()[0]?.proposalIds).toEqual([proposalId]);
  reopened.close();
});
