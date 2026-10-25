import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { captureGraph, graphContentHash } from "../src/model-graph.js";
import { loadModelView } from "../src/model-view-process.js";

async function captureDefinitions(source: string, names: readonly string[], check: (manifest: string) => Promise<void>, config = ""): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tesota-rules-"));
  try {
    await writeFile(join(root, "Rules.tla"), source);
    await writeFile(join(root, "Rules.cfg"), config);
    await writeFile(join(root, "reached.dot"), 'digraph {\n1 [label="door = 0"]\n}');
    const output = names.map(name => `Error: Invariant ${name} is violated by the initial state:\ndoor = 0\n\n`).join("") + "1 distinct state found";
    const capture = await captureGraph(join(root, "reached.dot"), output, {
      root, command: [], startedAt: "", finishedAt: "", processEnded: "exited", evidenceOutputHash: "", sessionFile: join(root, "s.jsonl"), model: "Rules.tla", config: "Rules.cfg", modelHash: graphContentHash(source), configHash: graphContentHash(config), effectiveConfigHash: "", evidenceHash: "", exitCode: 0,
    }, { sessionFile: join(root, "s.jsonl") });
    expect(capture.status).toBe("captured");
    await check(capture.manifest ?? "");
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("captures a simple invariant verbatim and binds its text to the model hash", async () => {
  const source = '---- MODULE Rules ----\nVARIABLE door\nDarkWhenLocked == door = "locked" => lamp = "off"\n====\n';
  await captureDefinitions(source, ["DarkWhenLocked"], async manifest => {
    const data = JSON.parse(await readFile(manifest, "utf8"));
    expect(data.ruleDefinitions).toEqual({ modelHash: graphContentHash(source), properties: { DarkWhenLocked: 'door = "locked" => lamp = "off"' } });
    expect((await loadModelView(manifest, {}, new AbortController().signal)).ruleDefinitions).toEqual(data.ruleDefinitions.properties);
    await writeFile(manifest, JSON.stringify({ ...data, ruleDefinitions: { ...data.ruleDefinitions, modelHash: "mismatch" } }));
    expect((await loadModelView(manifest, {}, new AbortController().signal)).ruleDefinitions).toEqual({});
  });
});

it("omits parameterized and imported operators without guessing", async () => {
  const source = '---- MODULE Rules ----\nEXTENDS Other\nWithParameter(x) == x > 0\n====\n';
  await captureDefinitions(source, ["WithParameter", "Imported"], async manifest => {
    expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({});
  });
});

it("cuts definition text at 400 characters with an ellipsis", async () => {
  const source = '---- MODULE Rules ----\nLong == "' + "x".repeat(410) + '"\n====\n';
  await captureDefinitions(source, ["Long"], async manifest => {
    expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({ Long: '"' + "x".repeat(398) + "…" });
  });
});

it("omits text when indentation leaves a top-level definition boundary in doubt", async () => {
  const source = '---- MODULE Rules ----\nSafe == door = 0\n  Next == door = 1\n====\n';
  await captureDefinitions(source, ["Safe"], async manifest => {
    expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({});
  });
});

it("omits unsupported function or infix definition boundaries instead of attaching them", async () => {
  for (const next of ['f[x \\in S] == x', 'a ++ b == a + b']) {
    const source = `---- MODULE Rules ----\nSafe == door = 0\n${next}\n====\n`;
    await captureDefinitions(source, ["Safe"], async manifest => {
      expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({});
    });
  }
});

it("omits a property whose definition the config substitutes", async () => {
  const source = '---- MODULE Rules ----\nSafe == door = 0\nOther == FALSE\n====\n';
  await captureDefinitions(source, ["Safe"], async manifest => {
    expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({});
  }, 'CONSTANT Safe <- Other\nINVARIANT Safe\n');
});

it("omits a body with an ambiguous trailing comment or separator", async () => {
  for (const between of ['\\* Documentation for Next\n', '-------------------------\n']) {
    const source = `---- MODULE Rules ----\nSafe == door = 0\n${between}Next == door = 1\n====\n`;
    await captureDefinitions(source, ["Safe"], async manifest => {
      expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({});
    });
  }
});

it("omits intervening top-level statements rather than attributing them to a rule", async () => {
  for (const statement of ['ASSUMPTION door = 0', 'AXIOM door = 0', 'PROPOSITION door = 0', 'COROLLARY door = 0', 'USE Safe', 'HIDE Safe']) {
    const source = `---- MODULE Rules ----\nSafe == door = 0\n${statement}\nNext == door = 1\n====\n`;
    await captureDefinitions(source, ["Safe"], async manifest => {
      expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({});
    });
  }
});

it("does not mistake a column-zero operator call for the following parameterized header", async () => {
  const source = '---- MODULE Rules ----\nSafe == door = 0 /\\\nOk(door)\nHelper(x) == x\n====\n';
  await captureDefinitions(source, ["Safe"], async manifest => {
    expect(JSON.parse(await readFile(manifest, "utf8")).ruleDefinitions.properties).toEqual({ Safe: 'door = 0 /\\\nOk(door)' });
  });
});
