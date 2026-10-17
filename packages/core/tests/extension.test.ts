import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../../src/evidence.ts";
import type { ProofOutcome } from "../../../src/verification/proof-outcome-rule.ts";
import type { ExtensionFactory, Session } from "../../../src/contract.ts";
import { createSession } from "../src/session.ts";
import { tesotaEngine } from "./adapters/tesota.ts";
import { scriptedReply } from "./scripted.ts";

/** Every proof passes and every mutant fails, so the gate settles without Dafny: the extension's wiring is under test. */
const lemmascript = { ...await import("../../../src/verification/lemmascript-verifier.ts") };
mock.module("../../../src/verification/lemmascript-verifier.ts", () => ({
  ...lemmascript,
  proveFile: (_root: string, path: string): Promise<Evidence> => Promise.resolve({ verifier: "lemmascript", claim: `claim of ${path}`,
    limits: "", outcome: "passed", output: "1 verified, 0 errors", durationMs: 1, files: [path, path.replace(/\.ts$/u, ".dfy")],
    contentHash: `hash of ${path}` }),
  proveSource: () => Promise.resolve("failed" satisfies ProofOutcome),
}));
const { provideHost } = await import("../../../src/host.ts");
const { shellHost } = await import("../src/shell/surface.ts");
provideHost(shellHost());
const { default: tesota } = await import("../../../src/tesota.ts");
const { entryReceipt, isReceipt } = await import("../../../src/receipt.ts");

/**
 * Tesota's verification, whole, as the session's verifier (#441), so its gate
 * is mandatory: it offers `prove` once the agent writes a contract, and
 * settles the run with a receipt.
 */
const open: Session[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const contract = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-extension-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "notes.md"), "# Notes\n");
  git(cwd, "init", "-q");
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return cwd;
}

for (const engine of [tesotaEngine]) {
  describe(engine.name, () => {
    test("Tesota's extension offers prove after a contract is written, and settles the run with one receipt from its base", async () => {
      let active: string[] = [];
      let receipts: unknown[] = [];
      // What Tesota's extension left, as the next request's settlement reads it.
      const probe: ExtensionFactory = (pi) => {
        pi.on("agent_before_settle", (_event, ctx) => {
          active = pi.getActiveTools();
          if (receipts.length === 0) receipts = ctx.sessionManager.getBranch().map(entryReceipt).filter((found) => found !== undefined);
          return undefined;
        });
      };
      const cwd = repository();
      const base = git(cwd, "rev-parse", "HEAD");
      // The agent commits its change, which must hide nothing from the gate.
      const commit = "git add -A; git -c user.name=t -c user.email=t@t commit -qm change";
      const shell = engine.shell;
      const session = await engine.createSession({ cwd, extensions: [probe],
        verifier: (pi, request) => { tesota(pi, request); },
        script: [{ tool: "write", args: { path: "src/rule.ts", content: contract } }, { tool: shell, args: { command: commit } },
          "written", "a restatement", "a restatement", "you're welcome", "you're welcome"] });
      open.push(session);
      await session.prompt("add f");
      expect(session.outcome()).toBe("completed");
      expect(git(cwd, "rev-parse", "HEAD")).not.toBe(base);
      await session.prompt("thanks");
      expect(active).toContain("prove");
      expect(receipts).toHaveLength(1);
      const [receipt] = receipts;
      expect(isReceipt(receipt)).toBe(true);
      expect(receipt).toMatchObject({ base, proofs: [{ path: "src/rule.ts", verdict: "proved" }] });
    });
  });
}

describe("the thinking level on @tesota/core", () => {
  /** The level an extension reads and the reasoning the provider is asked for, for a model that reasons or not. */
  async function levels(reasoning: boolean, thinkingLevel?: "off" | "high"): Promise<{ asked?: string; read?: string }> {
    let asked: string | undefined = "unset";
    let read: string | undefined;
    const faux = fauxProvider();
    faux.setResponses([scriptedReply({ seen: (_context, options) => { asked = options?.reasoning; }, reply: "done" })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const session = createSession({ cwd: mkdtempSync(join(tmpdir(), "tesota-core-thinking-")),
      folder: mkdtempSync(join(tmpdir(), "tesota-core-sessions-")), models, model: { ...faux.getModel(), reasoning },
      ...thinkingLevel === undefined ? {} : { thinkingLevel },
      verifier: (pi) => { pi.on("agent_before_settle", () => { read = pi.getThinkingLevel(); return undefined; }); } });
    open.push(session);
    await session.prompt("go");
    return { ...asked === undefined ? {} : { asked }, ...read === undefined ? {} : { read } };
  }

  test("a reasoning model is asked for the session's level, which extensions read", async () => {
    expect(await levels(true, "high")).toEqual({ asked: "high", read: "high" });
  });

  test("off asks for no reasoning, and a model that does not reason is off whatever the session says", async () => {
    expect(await levels(true, "off")).toEqual({ read: "off" });
    expect(await levels(false, "high")).toEqual({ read: "off" });
  });
});
