import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { hostProvider } from "../src/host-environment.js";
import { CodingSession, workingAgentSetup } from "../src/integrations/pi-coding-session.js";

/**
 * A Pi session has exactly the tools Tesota gives it (the engine contract).
 * Pi 0.99 adds codemode, tool search and MCP as built-in extensions, which
 * Pi's own CLI loads; an SDK session must get none of them, whatever the
 * workspace's `.pi` folder asks for, and a resumed session likewise.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("sends the model only Tesota's tools, and starts no MCP server, even when the workspace asks for Pi's built-ins", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tesota-pi-tools-")));
  roots.push(base);
  const root = join(base, "repo");
  const marker = join(base, "mcp-server-started");
  await mkdir(join(root, ".pi"), { recursive: true });
  // A project MCP server whose tools would be sent directly, and that leaves a marker if Pi ever starts it.
  await writeFile(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project: {
    command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
    exposure: "direct" } } }));
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }));

  const sent: string[][] = [];
  const faux = fauxProvider({ models: [{ id: "scripted" }] });
  faux.setResponses([(context) => {
    // Pi 0.99 carries the declared tools in the transcript's system messages, as every provider receives them.
    sent.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return fauxAssistantMessage([fauxText("Done.")]);
  }]);
  const runtime = await ModelRuntime.create({ authPath: join(base, "auth.json"), modelsPath: null, refreshOnCreate: false,
    allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel(faux.provider.id, "scripted");
  if (model === undefined) throw new Error("The scripted model is missing");

  const setup = workingAgentSetup({ cwd: root, environment: await hostProvider.prepare(root), sandboxed: false,
    approveCommand: async () => "deny" });
  const session = await CodingSession.start({ cwd: root, modelRuntime: runtime, model, ...setup });
  try {
    expect(await session.run("Say done.", new AbortController().signal)).toEqual({ status: "completed", reply: "Done." });
  } finally { session.dispose(); }

  expect(sent).toEqual([setup.tools.map((tool) => tool.name)]);
  expect(sent[0]).not.toEqual(expect.arrayContaining(["codemode"]));
  expect(sent[0]?.some((name) => name === "tool_search" || name.startsWith("mcp__"))).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

it("sends a resumed session only Tesota's tools, as its first request did", async () => {
  // Pi restores a saved session's tools from its transcript, and since 1.0 keeps any not yet registered pending.
  const root = await realpath(await mkdtemp(join(tmpdir(), "tesota-pi-resume-")));
  roots.push(root);
  const directory = join(root, ".sessions");
  const sent: string[][] = [];
  const faux = fauxProvider({ models: [{ id: "scripted" }] });
  const reply: FauxResponseFactory = (context) => {
    sent.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return fauxAssistantMessage([fauxText("Done.")]);
  };
  faux.setResponses([reply, reply]);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false,
    allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel(faux.provider.id, "scripted");
  if (model === undefined) throw new Error("The scripted model is missing");
  const setup = workingAgentSetup({ cwd: root, environment: await hostProvider.prepare(root), sandboxed: false,
    approveCommand: async () => "deny" });

  const first = await CodingSession.start({ cwd: root, modelRuntime: runtime, model, ...setup,
    sessionManager: SessionManager.create(root, directory, { id: "kept" }) });
  try { await first.run("Say done.", new AbortController().signal); } finally { first.dispose(); }
  const saved = SessionManager.findById(root, "kept", directory);
  if (saved === undefined) throw new Error("The first session was not saved");
  const resumed = await CodingSession.start({ cwd: root, modelRuntime: runtime, model, ...setup,
    sessionManager: SessionManager.open(saved, directory, root) });
  try {
    expect(resumed.resumed).toBe(true);
    expect(await resumed.run("Say done again.", new AbortController().signal)).toEqual({ status: "completed", reply: "Done." });
  } finally { resumed.dispose(); }

  const names = setup.tools.map((tool) => tool.name);
  expect(sent).toEqual([names, names]);
});
